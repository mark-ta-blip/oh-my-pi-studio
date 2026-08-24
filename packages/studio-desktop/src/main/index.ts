import * as path from "node:path";
import {
	app,
	clipboard,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	Menu,
	Notification,
	type OpenDialogOptions,
} from "electron";
import { APP_USER_MODEL_ID, loginItemsAreSupported, resolveLoginItemSettings } from "./app-identity";
import { isStudioQuitRequest, parseStudioDesktopArgs } from "./instance-args";
import { isStudioIpcSender } from "./ipc-sender";
import { parseNotificationContent } from "./notification-content";
import { createDesktopPaths, resolveTrayIconPath } from "./paths";
import {
	describeError,
	formatStudioStartupFailure,
	type StudioStartupState,
	toStudioStartupFailure,
} from "./startup-state";
import { t } from "./strings";
import { type StudioServerProcess, smokeTestStudioSidecar, startStudioServer } from "./studio-server";
import { TrayManager } from "./tray-manager";
import { parseWindowControlAction } from "./window-chrome";
import { WindowManager } from "./window-manager";

const { hidden: startHidden, quitExisting, smokeTest } = parseStudioDesktopArgs(process.argv);
const hasLock = smokeTest || app.requestSingleInstanceLock(quitExisting ? { quit: true } : undefined);
if (!hasLock) {
	app.quit();
} else {
	const packageRoot = path.resolve(import.meta.dirname, "..", "..");
	let desktopPaths: ReturnType<typeof createDesktopPaths> | undefined;
	let windowManager: WindowManager | undefined;
	let trayManager: TrayManager | undefined;
	let studioServer: StudioServerProcess | undefined;
	let studioServerStartup: Promise<StudioServerProcess> | undefined;
	let studioServerStartupAbort: AbortController | undefined;
	let startupState: StudioStartupState = { kind: "progress", stage: "locating" };
	let startupInFlight: Promise<void> | undefined;
	let shutdownStarted = false;
	/**
	 * Notifications still on screen.
	 *
	 * A `Notification` that is garbage collected while displayed takes its click
	 * handler with it, so activating it does nothing. Holding a reference until it
	 * closes is what makes clicking reliable.
	 */
	const liveNotifications = new Set<Notification>();

	/**
	 * Whether OMP Studio is registered to start at login.
	 *
	 * Only offered from a packaged app: an unpackaged run would register the Electron
	 * binary with no project path, so login would start something that is not Studio.
	 */
	function loginItemsAvailable(): boolean {
		return app.isPackaged && loginItemsAreSupported(process.platform);
	}

	function readOpenAtLogin(): boolean {
		if (!loginItemsAvailable()) return false;
		const probe = resolveLoginItemSettings(process.platform, process.execPath, true);
		return app.getLoginItemSettings({ path: probe.path, args: probe.args }).openAtLogin;
	}

	function setOpenAtLogin(enabled: boolean): void {
		if (!loginItemsAvailable()) return;
		app.setLoginItemSettings(resolveLoginItemSettings(process.platform, process.execPath, enabled));
		trayManager?.refresh();
	}

	function publishStartupState(state: StudioStartupState): void {
		startupState = state;
		windowManager?.publishStartupState(state);
	}

	/**
	 * Reject a privileged call from anything but the Studio window. Every channel
	 * below reaches the filesystem, the browser, or the notification centre.
	 */
	function requireStudioSender(event: IpcMainInvokeEvent): void {
		if (isStudioIpcSender(event.sender, windowManager?.window)) return;
		throw new Error(t("ipc.senderRejected"));
	}

	/**
	 * Splash channels answer only while the splash owns the window. The window keeps
	 * one preload across both documents, so this is what keeps the Studio client
	 * from reaching startup controls that mean nothing to it.
	 */
	function requireSplashSender(event: IpcMainInvokeEvent): void {
		requireStudioSender(event);
		if (windowManager?.showingSplash !== true) throw new Error(t("ipc.senderRejected"));
	}

	function installIpc(): void {
		ipcMain.handle("omp-studio:open-external", async (event, url: unknown) => {
			requireStudioSender(event);
			if (typeof url !== "string") throw new TypeError(t("ipc.urlRequired"));
			if (!windowManager) throw new Error(t("ipc.windowNotReady"));
			await windowManager.openExternal(url);
		});
		ipcMain.handle("omp-studio:select-workspace", async event => {
			requireStudioSender(event);
			const options = {
				properties: ["openDirectory", "createDirectory"],
				title: t("workspace.pickerTitle"),
			} satisfies OpenDialogOptions;
			const window = windowManager?.window;
			const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
			return result.canceled ? null : (result.filePaths[0] ?? null);
		});
		ipcMain.handle("omp-studio:notify", (event, title: unknown, body: unknown) => {
			requireStudioSender(event);
			const content = parseNotificationContent(title, body);
			if (!content || !Notification.isSupported()) return;
			const notification = new Notification({ title: content.title, body: content.body });
			liveNotifications.add(notification);
			const forget = (): void => {
				liveNotifications.delete(notification);
			};
			// Clicking a notification about a finished run has to reach the window it
			// is about, including when that window is hidden in the tray or minimized.
			notification.on("click", () => windowManager?.show());
			notification.on("close", forget);
			notification.on("failed", forget);
			notification.show();
		});
		// The window is frameless, so the title bar the client renders is the only
		// chrome there is. These two channels are what make it a real title bar.
		ipcMain.handle("omp-studio:window-state", event => {
			requireStudioSender(event);
			if (!windowManager) throw new Error(t("ipc.windowNotReady"));
			return windowManager.chromeState;
		});
		ipcMain.handle("omp-studio:window-control", (event, action: unknown) => {
			requireStudioSender(event);
			const control = parseWindowControlAction(action);
			if (control === undefined) throw new TypeError(t("ipc.windowActionRequired"));
			if (!windowManager) throw new Error(t("ipc.windowNotReady"));
			windowManager.applyWindowControl(control);
		});
		ipcMain.handle("omp-studio:startup-state", event => {
			requireSplashSender(event);
			return startupState;
		});
		ipcMain.handle("omp-studio:retry-startup", async event => {
			requireSplashSender(event);
			await startStudio();
		});
		ipcMain.handle("omp-studio:open-log-folder", event => {
			requireSplashSender(event);
			windowManager?.openLogFolder();
		});
		ipcMain.handle("omp-studio:copy-startup-failure", event => {
			requireSplashSender(event);
			if (startupState.kind !== "failure") return;
			clipboard.writeText(formatStudioStartupFailure(startupState));
		});
	}

	/**
	 * Spawn the sidecar and hand the window over to the Studio client.
	 *
	 * Re-entrant by design: the splash's retry calls straight back into this, so a
	 * failed startup never requires relaunching the app. Concurrent calls share the
	 * one in-flight attempt.
	 */
	function startStudio(): Promise<void> {
		if (startupInFlight) return startupInFlight;
		const paths = desktopPaths;
		if (!paths) return Promise.resolve();
		const attempt = (async (): Promise<void> => {
			publishStartupState({ kind: "progress", stage: "locating" });
			// A retry after a partial start must not leave the previous sidecar behind.
			const previous = studioServer;
			studioServer = undefined;
			await previous?.stop().catch(() => undefined);

			studioServerStartupAbort = new AbortController();
			studioServerStartup = startStudioServer({
				paths,
				packaged: app.isPackaged,
				command: app.isPackaged ? undefined : process.env.OMP_STUDIO_OMP_EXECUTABLE,
				signal: studioServerStartupAbort.signal,
			});
			try {
				publishStartupState({ kind: "progress", stage: "starting" });
				const startedServer = await studioServerStartup;
				studioServer = startedServer;
				if (shutdownStarted) return;
				publishStartupState({ kind: "progress", stage: "loading" });
				await windowManager?.loadStudio(startedServer.url);
			} catch (error) {
				if (shutdownStarted) return;
				const failure = toStudioStartupFailure(error);
				process.stderr.write(`OMP Studio could not start: ${formatStudioStartupFailure(failure)}\n`);
				publishStartupState(failure);
				// The window stays open on the splash, so the failure is recoverable.
				windowManager?.show();
			} finally {
				studioServerStartup = undefined;
				studioServerStartupAbort = undefined;
			}
		})();
		const tracked: Promise<void> = attempt.finally(() => {
			if (startupInFlight === tracked) startupInFlight = undefined;
		});
		startupInFlight = tracked;
		return tracked;
	}

	async function shutdown(): Promise<void> {
		if (shutdownStarted) return;
		shutdownStarted = true;
		// Every step here is best-effort. A throw before app.exit() would strand a
		// hidden window and an orphaned sidecar with no way left to quit the app.
		try {
			studioServerStartupAbort?.abort();
			windowManager?.allowClose();
			await windowManager?.save();
			await studioServerStartup?.catch(() => undefined);
			await studioServer?.stop();
			trayManager?.destroy();
		} catch (error) {
			process.stderr.write(`OMP Studio shutdown error: ${describeError(error)}\n`);
		} finally {
			app.exit(0);
		}
	}

	function failSmokeTest(error: unknown): void {
		const failure = toStudioStartupFailure(error);
		process.stderr.write(`OMP Studio desktop smoke failed: ${formatStudioStartupFailure(failure)}\n`);
		app.exit(1);
	}

	app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
		if (isStudioQuitRequest(argv, additionalData)) {
			void shutdown();
			return;
		}
		windowManager?.show();
	});
	// Only reachable when the tray is unavailable; with a tray, close hides the
	// window and never closes it.
	app.on("window-all-closed", () => {
		if (trayManager?.available !== true) void shutdown();
	});
	app.on("before-quit", event => {
		if (shutdownStarted) return;
		event.preventDefault();
		void shutdown();
	});

	app.whenReady()
		.then(async () => {
			if (shutdownStarted) return;
			// Holding the lock with --quit means no instance was running to stop.
			if (quitExisting) {
				app.exit(0);
				return;
			}
			const paths = createDesktopPaths(app.getPath("userData"), process.resourcesPath, packageRoot);
			desktopPaths = paths;
			if (smokeTest) {
				try {
					await smokeTestStudioSidecar({
						paths,
						packaged: app.isPackaged,
						command: app.isPackaged ? undefined : process.env.OMP_STUDIO_OMP_EXECUTABLE,
					});
					app.exit(0);
				} catch (error) {
					failSmokeTest(error);
				}
				return;
			}
			// Windows attributes notifications to an AUMID rather than to a process, and
			// off macOS there is no use for an application menu above a frameless window
			// that draws its own title bar. Both are set before the window exists, so
			// there is no menu bar to flash and no toast without an identity.
			if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
			if (process.platform !== "darwin") Menu.setApplicationMenu(null);
			windowManager = new WindowManager(paths);
			installIpc();
			await windowManager.createShell({ hidden: startHidden });
			const studioWindow = windowManager;
			trayManager = new TrayManager({
				iconPath: resolveTrayIconPath(paths, app.isPackaged),
				state: () => ({
					loginItemsSupported: loginItemsAvailable(),
					openAtLogin: readOpenAtLogin(),
					windowVisible: studioWindow.visible,
				}),
				actions: {
					hide: () => studioWindow.hide(),
					openLogFolder: () => studioWindow.openLogFolder(),
					quit: () => void app.quit(),
					setOpenAtLogin,
					show: () => studioWindow.show(),
				},
			});
			windowManager.onVisibilityChange(() => trayManager?.refresh());
			if (!trayManager.available) {
				// No tray means no way to reopen a hidden window, so close has to
				// quit instead. See the window-all-closed handler above. A --hidden
				// start would also be unreachable, so it is overridden here.
				process.stderr.write(
					`OMP Studio tray unavailable (${trayManager.failure ?? "unknown"}); close will quit.\n`,
				);
				windowManager.enableCloseToQuit();
				windowManager.show();
			}
			await startStudio();
		})
		.catch(error => {
			// Only reachable if the window itself could not be created; a sidecar
			// failure is reported on the splash instead.
			if (shutdownStarted) return;
			process.stderr.write(`OMP Studio could not start its window: ${describeError(error)}\n`);
			dialog.showErrorBox(t("failure.title"), describeError(error));
			app.exit(1);
		});
}
