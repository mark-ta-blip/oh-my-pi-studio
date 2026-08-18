import * as path from "node:path";
import { app, dialog, ipcMain, Notification, type OpenDialogOptions } from "electron";
import { createDesktopPaths } from "./paths";
import { type StudioServerProcess, startStudioServer } from "./studio-server";
import { TrayManager } from "./tray-manager";
import { WindowManager } from "./window-manager";

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
	app.quit();
} else {
	const packageRoot = path.resolve(import.meta.dirname, "..", "..");
	let windowManager: WindowManager | undefined;
	let trayManager: TrayManager | undefined;
	let studioServer: StudioServerProcess | undefined;
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
		windowManager?.allowClose();
		await windowManager?.save();
		await studioServer?.stop();
		trayManager?.destroy();
		app.exit(0);
	}

	async function failStartup(error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		windowManager?.allowClose();
		await studioServer?.stop();
		trayManager?.destroy();
		process.stderr.write(`OMP Studio could not start: ${message}\n`);
		dialog.showErrorBox("OMP Studio could not start", message);
		app.exit(1);
	}

	app.on("second-instance", () => windowManager?.show());
	app.on("before-quit", event => {
		if (shutdownStarted) return;
		event.preventDefault();
		void shutdown();
	});

	app.whenReady()
		.then(async () => {
			const paths = createDesktopPaths(app.getPath("userData"), process.resourcesPath, packageRoot);
			windowManager = new WindowManager(paths);
			installIpc();
			studioServer = await startStudioServer({
				paths,
				packaged: app.isPackaged,
				command: process.env.OMP_STUDIO_OMP_EXECUTABLE,
			});
			await windowManager.create(studioServer.url);
			trayManager = new TrayManager(windowManager, () => void app.quit());
		})
		.catch(error => {
			void failStartup(error);
		});
}
