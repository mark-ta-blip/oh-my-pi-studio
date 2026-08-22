import * as path from "node:path";
import { BrowserWindow, dialog, screen, session, shell } from "electron";
import { resolveExternalHttpUrl } from "./external-url";
import type { DesktopPaths } from "./paths";
import type { StudioStartupState } from "./startup-state";
import { t } from "./strings";
import {
	clampWindowStateToDisplays,
	MIN_WINDOW_HEIGHT,
	MIN_WINDOW_WIDTH,
	readWindowState,
	writeWindowState,
} from "./window-state";

const STUDIO_STARTUP_STATE_CHANNEL = "omp-studio:startup-state";

export interface StudioWindowCreateOptions {
	/** Leave the window hidden so a `--hidden` launch starts in the tray. */
	hidden?: boolean;
}

export class WindowManager {
	#window: BrowserWindow | null = null;
	#allowClose = false;
	#closeToQuit = false;
	#saveTimer: NodeJS.Timeout | undefined;
	#studioOrigin: string | undefined;
	#cspInstalled = false;

	constructor(readonly paths: DesktopPaths) {}

	/**
	 * Open the window before the sidecar is spawned, showing the splash.
	 *
	 * Startup can take up to the sidecar's ready timeout. Creating the window only
	 * after that left the app with nothing on screen for the whole wait, and left a
	 * failure with nowhere to render but a modal dialog.
	 */
	async createShell(options: StudioWindowCreateOptions = {}): Promise<BrowserWindow> {
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
				title: t("preload.title"),
				message: t("preload.message"),
				detail: t("preload.detail"),
			});
		});
		this.#installNavigationPolicy(window);
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
		await window.loadFile(path.join(this.paths.packageRoot, "dist", "splash", "index.html"));
		return window;
	}

	/** True until the Studio client has loaded, which is when splash IPC stops answering. */
	get showingSplash(): boolean {
		return this.#studioOrigin === undefined;
	}

	/** Push typed startup state to the splash. Ignored once the window is gone. */
	publishStartupState(state: StudioStartupState): void {
		const window = this.#window;
		if (!window || window.isDestroyed()) return;
		window.webContents.send(STUDIO_STARTUP_STATE_CHANNEL, state);
	}

	/** Replace the splash with the Studio client and lock navigation to its origin. */
	async loadStudio(serverUrl: string): Promise<void> {
		const window = this.#window;
		if (!window || window.isDestroyed()) throw new Error(t("ipc.windowNotReady"));
		const origin = new URL(serverUrl).origin;
		this.#installContentSecurityPolicy(origin);
		this.#studioOrigin = origin;
		try {
			await window.loadURL(serverUrl);
		} catch (error) {
			// A failed navigation must not leave the shell believing the client owns
			// the window, or the splash could no longer report the failure.
			this.#studioOrigin = undefined;
			throw error;
		}
	}

	/** Reveal the sidecar log directory, so a failed startup is actionable. */
	openLogFolder(): void {
		shell.showItemInFolder(this.paths.sidecarLogPath);
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
		if (!externalUrl) throw new Error(t("startup.externalOnlyHttp"));
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

	/**
	 * Installed once, before any document loads. Until `loadStudio` records an
	 * origin there is no in-app destination at all, so every navigation the splash
	 * could attempt is deflected outward.
	 */
	#installNavigationPolicy(window: BrowserWindow): void {
		window.webContents.setWindowOpenHandler(details => {
			void this.openExternal(details.url).catch(() => undefined);
			return { action: "deny" };
		});
		window.webContents.on("will-navigate", (event, navigationUrl) => {
			try {
				if (this.#studioOrigin !== undefined && new URL(navigationUrl).origin === this.#studioOrigin) return;
			} catch {}
			event.preventDefault();
			void this.openExternal(navigationUrl).catch(() => undefined);
		});
	}

	#installContentSecurityPolicy(origin: string): void {
		if (this.#cspInstalled) return;
		this.#cspInstalled = true;
		// Widened from the server's own header only by `'unsafe-inline'` for styles,
		// which the Studio client still needs. The splash document carries its own
		// stricter policy in a meta tag, because file:// responses never reach here.
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
