import * as path from "node:path";
import { app, dialog, ipcMain, Notification, type OpenDialogOptions } from "electron";
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

const smokeTest = process.argv.includes("--smoke-test");
const hasLock = smokeTest || app.requestSingleInstanceLock();
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

	function installIpc(): void {
		ipcMain.handle("omp-studio:open-external", async (_event, url: unknown) => {
			if (typeof url !== "string") throw new TypeError("OMP Studio can only open a URL.");
			if (!windowManager) throw new Error("OMP Studio window is not ready.");
			await windowManager.openExternal(url);
		});
		ipcMain.handle("omp-studio:select-workspace", async () => {
			const options = {
				properties: ["openDirectory", "createDirectory"],
				title: "Select workspace",
			} satisfies OpenDialogOptions;
			const window = windowManager?.window;
			const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
			return result.canceled ? null : (result.filePaths[0] ?? null);
		});
		ipcMain.handle("omp-studio:notify", (_event, title: string, body: string) => {
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

	app.on("second-instance", () => windowManager?.show());
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
				await windowManager.create(startedServer.url);
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
				// quit instead. See the window-all-closed handler below.
				process.stderr.write(
					`OMP Studio tray unavailable (${trayManager.failure ?? "unknown"}); close will quit.\n`,
				);
				windowManager.enableCloseToQuit();
			}
		})
		.catch(error => {
			if (!shutdownStarted) void failStartup(error);
		});
}
