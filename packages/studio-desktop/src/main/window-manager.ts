import * as path from "node:path";
import { BrowserWindow, dialog, screen, session, shell } from "electron";
import { resolveExternalHttpUrl } from "./external-url";
import type { DesktopPaths } from "./paths";
import {
	clampWindowStateToDisplays,
	MIN_WINDOW_HEIGHT,
	MIN_WINDOW_WIDTH,
	readWindowState,
	writeWindowState,
} from "./window-state";

export interface StudioWindowCreateOptions {
	/** Leave the window hidden so a `--hidden` launch starts in the tray. */
	hidden?: boolean;
}

export class WindowManager {
	#window: BrowserWindow | null = null;
	#allowClose = false;
	#closeToQuit = false;
	#saveTimer: NodeJS.Timeout | undefined;

	constructor(readonly paths: DesktopPaths) {}

	async create(serverUrl: string, options: StudioWindowCreateOptions = {}): Promise<BrowserWindow> {
		const saved = await readWindowState(this.paths.windowStatePath);
		const state = clampWindowStateToDisplays(
			saved,
			screen.getAllDisplays().map(display => display.workArea),
		);
		const preloadPath = path.join(this.paths.packageRoot, "dist", "preload", "index.cjs");
		const window = new BrowserWindow({
			...state,
			show: false,
			minWidth: MIN_WINDOW_WIDTH,
			minHeight: MIN_WINDOW_HEIGHT,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				preload: preloadPath,
			},
		});
		this.#window = window;
		window.webContents.once("preload-error", () => {
			void dialog.showMessageBox(window, {
				type: "error",
				title: "OMP Studio desktop controls are unavailable",
				message: "OMP Studio could not initialize its desktop integration.",
				detail: "Restart OMP Studio. If the issue persists, reinstall the app.",
			});
		});
		this.#installNavigationPolicy(window, serverUrl);
		window.on("move", () => this.#scheduleSave());
		window.on("resize", () => this.#scheduleSave());
		// Minimize stays a real minimize: hiding it too leaves the taskbar and the
		// window both empty, so the tray would be the only way back.
		window.on("close", event => {
			if (this.#allowClose || this.#closeToQuit) return;
			event.preventDefault();
			window.hide();
		});
		if (!options.hidden) window.once("ready-to-show", () => window.show());
		await window.loadURL(serverUrl);
		return window;
	}

	get window(): BrowserWindow | null {
		return this.#window;
	}

	show(): void {
		this.#window?.show();
		this.#window?.focus();
	}

	hide(): void {
		this.#window?.hide();
	}

	allowClose(): void {
		this.#allowClose = true;
	}

	/**
	 * Let close actually close the window. Used when no tray was created: hiding
	 * would otherwise leave the app running with no window and no tray to reopen
	 * it from.
	 */
	enableCloseToQuit(): void {
		this.#closeToQuit = true;
	}

	async openExternal(url: string): Promise<void> {
		const externalUrl = resolveExternalHttpUrl(url);
		if (!externalUrl) throw new Error("OMP Studio can only open HTTP or HTTPS links outside the app.");
		await shell.openExternal(externalUrl);
	}

	async save(): Promise<void> {
		if (!this.#window) return;
		await writeWindowState(this.paths.windowStatePath, this.#window.getBounds());
	}

	#scheduleSave(): void {
		if (this.#saveTimer) clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			void this.save();
		}, 250);
	}

	#installNavigationPolicy(window: BrowserWindow, serverUrl: string): void {
		const origin = new URL(serverUrl).origin;
		window.webContents.setWindowOpenHandler(details => {
			void this.openExternal(details.url).catch(() => undefined);
			return { action: "deny" };
		});
		window.webContents.on("will-navigate", (event, navigationUrl) => {
			try {
				if (new URL(navigationUrl).origin === origin) return;
			} catch {}
			event.preventDefault();
			void this.openExternal(navigationUrl).catch(() => undefined);
		});
		session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
			if (details.url.startsWith(origin)) {
				callback({
					responseHeaders: {
						...details.responseHeaders,
						"Content-Security-Policy": [
							"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
								"img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*;",
						],
					},
				});
				return;
			}
			callback({ responseHeaders: details.responseHeaders });
		});
	}
}
