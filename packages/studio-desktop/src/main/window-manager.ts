import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserWindow, dialog, session, shell } from "electron";
import { resolveExternalHttpUrl } from "./external-url";
import type { DesktopPaths } from "./paths";

interface WindowState {
	width: number;
	height: number;
	x?: number;
	y?: number;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 840 };

async function readWindowState(filePath: string): Promise<WindowState> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object") return DEFAULT_STATE;
		const value = parsed as Partial<WindowState>;
		if (
			typeof value.width !== "number" ||
			typeof value.height !== "number" ||
			!Number.isInteger(value.width) ||
			!Number.isInteger(value.height)
		) {
			return DEFAULT_STATE;
		}
		if (value.width < 800 || value.height < 600) return DEFAULT_STATE;
		return {
			width: value.width,
			height: value.height,
			...(typeof value.x === "number" && Number.isInteger(value.x) ? { x: value.x } : {}),
			...(typeof value.y === "number" && Number.isInteger(value.y) ? { y: value.y } : {}),
		};
	} catch {
		return DEFAULT_STATE;
	}
}

export class WindowManager {
	#window: BrowserWindow | null = null;
	#allowClose = false;
	#saveTimer: NodeJS.Timeout | undefined;

	constructor(readonly paths: DesktopPaths) {}

	async create(serverUrl: string): Promise<BrowserWindow> {
		const state = await readWindowState(this.paths.windowStatePath);
		const preloadPath = path.join(this.paths.packageRoot, "dist", "preload", "index.cjs");
		const window = new BrowserWindow({
			...state,
			show: false,
			minWidth: 800,
			minHeight: 600,
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
		window.on("minimize", () => window.hide());
		window.on("close", event => {
			if (this.#allowClose) return;
			event.preventDefault();
			window.hide();
		});
		window.once("ready-to-show", () => window.show());
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

	async openExternal(url: string): Promise<void> {
		const externalUrl = resolveExternalHttpUrl(url);
		if (!externalUrl) throw new Error("OMP Studio can only open HTTP or HTTPS links outside the app.");
		await shell.openExternal(externalUrl);
	}

	async save(): Promise<void> {
		if (!this.#window) return;
		const bounds = this.#window.getBounds();
		await fs.mkdir(path.dirname(this.paths.windowStatePath), { recursive: true });
		await fs.writeFile(this.paths.windowStatePath, JSON.stringify(bounds, null, 2), "utf8");
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
