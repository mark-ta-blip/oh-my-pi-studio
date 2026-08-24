import * as path from "node:path";
import { BrowserWindow, dialog, screen, shell } from "electron";
import { resolveExternalHttpUrl } from "./external-url";
import type { DesktopPaths } from "./paths";
import type { StudioStartupState } from "./startup-state";
import { t } from "./strings";
import {
	resolveWindowChromeOptions,
	resolveWindowChromePlatform,
	type WindowChromeState,
	type WindowControlAction,
	windowControlsAreDrawnInWindow,
} from "./window-chrome";
import {
	clampWindowStateToDisplays,
	MIN_WINDOW_HEIGHT,
	MIN_WINDOW_WIDTH,
	readWindowState,
	toWindowBounds,
	writeWindowState,
} from "./window-state";

const STUDIO_STARTUP_STATE_CHANNEL = "omp-studio:startup-state";
const STUDIO_WINDOW_STATE_CHANNEL = "omp-studio:window-state-change";

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
			...toWindowBounds(state),
			...resolveWindowChromeOptions(process.platform),
			show: false,
			// Fullscreen is a constructor option; maximize is not, so it is applied
			// below. Both happen before the window is shown, so a restored window
			// never visibly resizes itself on launch.
			fullscreen: state.fullScreen === true,
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
		if (state.maximized === true && state.fullScreen !== true) window.maximize();
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
		// The renderer draws the title bar, so it has to be told what the window did
		// whenever the change came from anywhere but its own control buttons: a snap
		// gesture, a double-click on the drag region, or the OS keyboard shortcuts.
		const onChromeChange = (): void => {
			this.#publishWindowState();
			this.#scheduleSave();
		};
		window.on("maximize", onChromeChange);
		window.on("unmaximize", onChromeChange);
		window.on("enter-full-screen", onChromeChange);
		window.on("leave-full-screen", onChromeChange);
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

	/**
	 * Replace the splash with the Studio client and lock navigation to its origin.
	 *
	 * No Content-Security-Policy is injected here. The shell used to override the
	 * server's header with a widened copy — `'unsafe-inline'` styles, `blob:` images,
	 * cross-port `http://127.0.0.1:*` — and dropping `base-uri` and
	 * `frame-ancestors` with it. The client needs none of that: its stylesheet is a
	 * served file, it has no inline `<style>` and no `style` attributes in markup,
	 * and it loads no blob images. Letting the server's header stand keeps the
	 * desktop policy identical to the browser one, so a policy change is made in one
	 * place and cannot silently apply to only one surface. The splash document is
	 * `file://`, which never reaches a response-header hook, so it carries its own
	 * stricter policy in a meta tag.
	 */
	async loadStudio(serverUrl: string): Promise<void> {
		const window = this.#window;
		if (!window || window.isDestroyed()) throw new Error(t("ipc.windowNotReady"));
		const origin = new URL(serverUrl).origin;
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

	/** What the renderer needs to draw the title bar for this window. */
	get chromeState(): WindowChromeState {
		const window = this.#window;
		const live = window !== null && !window.isDestroyed();
		return {
			controlsInWindow: windowControlsAreDrawnInWindow(process.platform),
			fullScreen: live && window.isFullScreen(),
			maximized: live && window.isMaximized(),
			platform: resolveWindowChromePlatform(process.platform),
		};
	}

	/**
	 * Run a window control the renderer asked for.
	 *
	 * `close` deliberately goes through `close()` rather than `destroy()`, so the
	 * rendered close button behaves exactly like the OS one: hidden to the tray when
	 * a tray exists, quitting when it does not.
	 */
	applyWindowControl(action: WindowControlAction): void {
		const window = this.#window;
		if (!window || window.isDestroyed()) throw new Error(t("ipc.windowNotReady"));
		switch (action) {
			case "minimize":
				window.minimize();
				return;
			case "toggle-maximize":
				// Leaving fullscreen first: a fullscreen window reports as maximized on
				// some platforms, so toggling would otherwise be a no-op the user cannot
				// escape without the keyboard.
				if (window.isFullScreen()) window.setFullScreen(false);
				else if (window.isMaximized()) window.unmaximize();
				else window.maximize();
				return;
			case "close":
				window.close();
				return;
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
		const window = this.#window;
		if (!window || window.isDestroyed()) return;
		// Normal bounds, not current bounds: a window saved while maximized would
		// otherwise restore to the display-filling size with nothing left to
		// unmaximize to.
		const maximized = window.isMaximized();
		const fullScreen = window.isFullScreen();
		await writeWindowState(this.paths.windowStatePath, {
			...window.getNormalBounds(),
			...(maximized ? { maximized: true } : {}),
			...(fullScreen ? { fullScreen: true } : {}),
		});
	}

	#publishWindowState(): void {
		const window = this.#window;
		if (!window || window.isDestroyed()) return;
		window.webContents.send(STUDIO_WINDOW_STATE_CHANNEL, this.chromeState);
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
}
