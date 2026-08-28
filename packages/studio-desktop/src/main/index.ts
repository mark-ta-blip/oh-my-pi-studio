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
import { installCommandShims, type ShimInstallStatus } from "./command-shim";
import { resolveDesktopRuntimeInfo } from "./desktop-runtime";
import {
	clearDesktopStorageSettings,
	defaultConfigRoot,
	desktopStorageSettingsFileName,
	hasMigratedConfig,
	hasMigratedState,
	migrateConfigRoot,
	migrateDesktopState,
	probeWritableDir,
	readDesktopStorageSettings,
	resolveEffectiveStorage,
	writeDesktopStorageSettings,
} from "./desktop-storage";
import { isStudioQuitRequest, parseStudioDesktopArgs } from "./instance-args";
import { isStudioIpcSender } from "./ipc-sender";
import { parseNotificationContent } from "./notification-content";
import { createDesktopPaths, resolveTrayIconPath } from "./paths";
import { verifySidecarBinary } from "./sidecar-repair";
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
	/** True when a saved state root was unwritable and the launch fell back to the default. */
	let storageRepaired = false;
	/** The last shim installation result, refreshed by the Desktop section's button. */
	let shimStatus: ShimInstallStatus = { dir: null, onDefaultPath: false, installed: false, conflict: false };
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
		// Relocation moves the state root (window geometry, sidecar log, and the
		// OMP config the sidecar runs under). The chosen path comes from
		// Electron's own dialog — never from the renderer — so the channel cannot
		// be pointed at an arbitrary location. The OMP config the sidecar
		// currently uses is copied into the new root, so the move carries the
		// user's providers and sessions with it. Relaunch picks the new root up.
		ipcMain.handle("omp-studio:relocate-state", async event => {
			requireStudioSender(event);
			const options = {
				properties: ["openDirectory", "createDirectory"],
				title: t("storage.pickerTitle"),
			} satisfies OpenDialogOptions;
			const window = windowManager?.window;
			const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
			if (result.canceled || !result.filePaths[0]) return { status: "canceled" };
			const stateRoot = result.filePaths[0];
			if (!(await probeWritableDir(stateRoot))) return { status: "unwritable" };
			const paths = desktopPaths;
			if (!paths) return { status: "unwritable" };
			// Persist the new pointer first — it is the only step here that can
			// throw, and the commit point. If the sidecar stop or a migration below
			// then fails, the app keeps running on the old root (its saved pointer
			// is the new one, but the next launch's whenReady re-migrates an empty
			// root, so nothing is lost) rather than running with a stopped sidecar
			// and the pointer not yet written.
			await writeDesktopStorageSettings(paths.storageSettingsPath, { stateRoot });
			// The config root holds SQLite databases the running sidecar keeps
			// open in WAL mode, so the copy happens after the sidecar is down:
			// a file-by-file copy of live .db and .db-wal files could land as an
			// inconsistent pair in the new root. Stopping first is what makes the
			// copy a consistent snapshot. The relaunch below restarts it.
			const previous = studioServer;
			studioServer = undefined;
			await previous?.stop().catch(() => undefined);
			// A brand-new root gets the current state; a root the user returned
			// to already has its own and is left as-is.
			if (!(await hasMigratedState(stateRoot))) {
				await migrateDesktopState(paths.stateRoot, stateRoot);
			}
			// The new root's config dir is derived from it, so it is never
			// "migrated" from the state root itself; the source is the config
			// root the sidecar runs under right now (the user's ~/.omp when this
			// launch has no explicit relocation).
			const currentConfigRoot = paths.configRoot ?? defaultConfigRoot(process.env);
			if (!(await hasMigratedConfig(path.join(stateRoot, "omp")))) {
				await migrateConfigRoot(currentConfigRoot, stateRoot);
			}
			app.relaunch();
			app.quit();
			return { status: "relaunching" };
		});
		// Drops the saved root so the next launch uses the default state dir.
		// Also the repair for an unwritable saved root.
		ipcMain.handle("omp-studio:reset-state-root", async event => {
			requireStudioSender(event);
			const paths = desktopPaths;
			if (!paths) return { status: "unready" };
			await clearDesktopStorageSettings(paths.storageSettingsPath);
			app.relaunch();
			app.quit();
			return { status: "relaunching" };
		});
		// Shell-owned runtime facts for the Desktop section: the sidecar binary,
		// the state root, the config root. Nothing that the boundary protects
		// (session paths, provider secrets, tool payloads) crosses this channel.
		ipcMain.handle("omp-studio:desktop-runtime", event => {
			requireStudioSender(event);
			const paths = desktopPaths;
			if (!paths) return null;
			return resolveDesktopRuntimeInfo(paths, app.isPackaged, process.platform, shimStatus, storageRepaired);
		});
		// Verifies the bundled sidecar is present (and executable off Windows).
		// Read-only: the app never repairs the installed sidecar itself; the
		// remedy for a missing binary is a reinstall.
		ipcMain.handle("omp-studio:repair-sidecar", async event => {
			requireStudioSender(event);
			const paths = desktopPaths;
			if (!paths) return { ok: false, message: t("repair.reinstall") };
			const result = await verifySidecarBinary(paths.serverResourceDir, process.platform);
			return result.ok ? { ok: true, message: t("repair.ok") } : { ok: false, message: t("repair.reinstall") };
		});
		// Re-runs the managed shim installation on demand and reports whether
		// the target directory is on the default PATH. Packaged-only, like the
		// startup install: a dev run would write a shim pointing at the dev
		// binary, which would outlive the session it was written for.
		ipcMain.handle("omp-studio:install-shims", async event => {
			requireStudioSender(event);
			const paths = desktopPaths;
			if (!paths) return { installed: false };
			if (!app.isPackaged) return shimStatus;
			shimStatus = await installCommandShims({
				platform: process.platform,
				env: process.env,
				appExecPath: process.execPath,
				sidecarPath: path.join(paths.serverResourceDir, process.platform === "win32" ? "omp.exe" : "omp"),
			});
			return shimStatus;
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
				configRoot: paths.configRoot,
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
			// The state root is user-relocatable. The pointer to it lives in the
			// platform-default userData dir (it cannot live inside the movable root),
			// and an unwritable saved root falls back to the default for this launch
			// instead of failing startup: the Desktop section then offers a repair.
			const defaultUserDataDir = app.getPath("userData");
			const storageSettings = await readDesktopStorageSettings(
				path.join(defaultUserDataDir, desktopStorageSettingsFileName()),
			);
			const storageWritable = storageSettings ? await probeWritableDir(storageSettings.stateRoot) : false;
			const storage = resolveEffectiveStorage(defaultUserDataDir, storageSettings, storageWritable);
			storageRepaired = storage.repaired;
			if (
				storageSettings &&
				storage.userDataDir !== defaultUserDataDir &&
				!(await hasMigratedState(storage.userDataDir))
			) {
				// A relocated root with no state of its own yet gets the default's
				// window geometry and log tree, so a move never starts blank.
				await migrateDesktopState(defaultUserDataDir, storage.userDataDir);
			}
			// Only an explicit relocation moves the sidecar's OMP config root;
			// otherwise it keeps the user's existing ~/.omp config and sessions.
			const configRoot =
				storageSettings && storage.userDataDir === storageSettings.stateRoot
					? path.join(storage.userDataDir, "omp")
					: undefined;
			const paths = createDesktopPaths(
				storage.userDataDir,
				defaultUserDataDir,
				process.resourcesPath,
				packageRoot,
				configRoot,
			);
			desktopPaths = paths;
			if (smokeTest) {
				try {
					await smokeTestStudioSidecar({
						paths,
						packaged: app.isPackaged,
						command: app.isPackaged ? undefined : process.env.OMP_STUDIO_OMP_EXECUTABLE,
						configRoot: paths.configRoot,
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
			// A packaged app can manage its own launcher command; a dev run would
			// write a shim pointing at the dev binary, which would outlive the
			// session it was written for. Best-effort: startup never depends on it.
			if (app.isPackaged) {
				try {
					shimStatus = await installCommandShims({
						platform: process.platform,
						env: process.env,
						appExecPath: process.execPath,
						sidecarPath: path.join(paths.serverResourceDir, process.platform === "win32" ? "omp.exe" : "omp"),
					});
				} catch (error) {
					process.stderr.write(`OMP Studio shim install failed: ${describeError(error)}\n`);
				}
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
