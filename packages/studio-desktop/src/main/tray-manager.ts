import { Menu, nativeImage, Tray } from "electron";
import type { WindowManager } from "./window-manager";

function createTrayIcon() {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#183f38"/><path fill="#fff" d="M4 4h2v8H4zm3 0h2v5H7zm3 0h2v8h-2z"/></svg>`;
	return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

export class TrayManager {
	#tray: Tray;

	constructor(windowManager: WindowManager, quit: () => void) {
		this.#tray = new Tray(createTrayIcon());
		this.#tray.setToolTip("OMP Studio");
		this.#tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "Show OMP Studio", click: () => windowManager.show() },
				{ label: "Hide OMP Studio", click: () => windowManager.hide() },
				{ type: "separator" },
				{ label: "Quit", click: quit },
			]),
		);
		this.#tray.on("double-click", () => windowManager.show());
	}

	destroy(): void {
		this.#tray.destroy();
	}
}
