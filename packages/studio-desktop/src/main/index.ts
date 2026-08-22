import * as path from "node:path";
import { app, dialog, type IpcMainInvokeEvent, ipcMain, Notification, type OpenDialogOptions } from "electron";
import { isStudioQuitRequest, parseStudioDesktopArgs } from "./instance-args";
import { isStudioIpcSender } from "./ipc-sender";
import { createDesktopPaths, resolveTrayIconPath } from "./paths";
import {
	type StudioServerProcess,
	StudioSidecarStartupError,
	smokeTestStudioSidecar,
	startStudioServer,
} from "./studio-server";
import { TrayManager } from "./tray-manager";
import { WindowManager } from "./window-manager";

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Startup failures are the one class of error with no UI behind it, so the
 * dialog has to carry the sidecar's own output and the log path with it.
 */
function describeStartupFailure(error: unknown): string {
	const message = describeError(error);
	if (!(error instanceof StudioSidecarStartupError)) return message;
	const sections = [message];
	if (error.stderrTail.length > 0) sections.push(`Recent OMP Studio server output:\n${error.stderrTail.join("\n")}`);
	if (error.logPath) sections.push(`Full server log:\n${error.logPath}`);
	return sections.join("\n\n");
}

const { hidden: startHidden, quitExisting, smokeTest } = parseStudioDesktopArgs(process.argv);
const hasLock = smokeTest || app.requestSingleInstanceLock(quitExisting ? { quit: true } : undefined);
if (!hasLock) {
	app.quit();
} else {
	const packageRoot = path.resolve(import.meta.dirname, "..", "..");
	let windowManager: WindowManager | undefined;
	let trayManager: TrayManager | undefined;
	let studioServer: StudioServerProcess | undefined;
	let studioServerStartup: Promise<StudioServerProcess> | undefined;
	let studioServerStartupAbort: AbortController | undefined;
	let shutdownStarted = false;

	/**
	 * Reject a privileged call from anything but the Studio window. Every channel
	 * below reaches the filesystem, the browser, or the notification centre.
	 */
	function requireStudioSender(event: IpcMainInvokeEvent): void {
		if (isStudioIpcSender(event.sender, windowManager?.window)) return;
		throw new Error("OMP Studio desktop controls are only available to the OMP Studio window.");
	}

	function installIpc(): void {
		ipcMain.handle("omp-studio:open-external", async (event, url: unknown) => {
			requireStudioSender(event);
			if (typeof url !== "string") throw new TypeError("OMP Studio can only open a URL.");
			if (!windowManager) throw new Error("OMP Studio window is not ready.");
			await windowManager.openExternal(url);
		});
		ipcMain.handle("omp-studio:select-workspace", async event => {
			requireStudioSender(event);
			const options = {
				properties: ["openDirectory", "createDirectory"],
				title: "Select workspace",
			} satisfies OpenDialogOptions;
			const window = windowManager?.window;
			const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
			return result.canceled ? null : (result.filePaths[0] ?? null);
		});
		ipcMain.handle("omp-studio:notify", (event, title: string, body: string) => {
			requireStudioSender(event);
			if (typeof title !== "string" || typeof body !== "string") return;
			new Notification({ title, body }).show();
		});
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

	async function failStartup(error: unknown): Promise<void> {
		if (shutdownStarted) return;
		shutdownStarted = true;
		const detail = describeStartupFailure(error);
		try {
			windowManager?.allowClose();
			await studioServer?.stop();
			trayManager?.destroy();
			process.stderr.write(`OMP Studio could not start: ${detail}\n`);
			dialog.showErrorBox("OMP Studio could not start", detail);
		} catch (cleanupError) {
			process.stderr.write(`OMP Studio startup cleanup error: ${describeError(cleanupError)}\n`);
		} finally {
			app.exit(1);
		}
	}

	function failSmokeTest(error: unknown): void {
		process.stderr.write(`OMP Studio desktop smoke failed: ${describeStartupFailure(error)}\n`);
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
			windowManager = new WindowManager(paths);
			installIpc();
			studioServerStartupAbort = new AbortController();
			studioServerStartup = startStudioServer({
				paths,
				packaged: app.isPackaged,
				command: app.isPackaged ? undefined : process.env.OMP_STUDIO_OMP_EXECUTABLE,
				signal: studioServerStartupAbort.signal,
			});
			try {
				const startedServer = await studioServerStartup;
				studioServer = startedServer;
				await windowManager.create(startedServer.url, { hidden: startHidden });
			} finally {
				studioServerStartup = undefined;
				studioServerStartupAbort = undefined;
			}
			trayManager = new TrayManager(
				windowManager,
				() => void app.quit(),
				resolveTrayIconPath(paths, app.isPackaged),
			);
			if (!trayManager.available) {
				// No tray means no way to reopen a hidden window, so close has to
				// quit instead. See the window-all-closed handler below. A --hidden
				// start would also be unreachable, so it is overridden here.
				process.stderr.write(
					`OMP Studio tray unavailable (${trayManager.failure ?? "unknown"}); close will quit.\n`,
				);
				windowManager.enableCloseToQuit();
				windowManager.show();
			}
		})
		.catch(error => {
			if (!shutdownStarted) void failStartup(error);
		});
}
