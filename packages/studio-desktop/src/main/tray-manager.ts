import { Menu, type NativeImage, nativeImage, Tray } from "electron";
import type { WindowManager } from "./window-manager";

function createTrayIcon(iconPath: string): NativeImage | undefined {
	const icon = nativeImage.createFromPath(iconPath);
	if (!icon.isEmpty()) return icon;
	return undefined;
}

export class TrayManager {
	#tray: Tray | undefined;

	constructor(windowManager: WindowManager, quit: () => void, iconPath: string) {
		const icon = createTrayIcon(iconPath);
		if (!icon) return;
		this.#tray = new Tray(icon);
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
		this.#tray?.destroy();
	}
}
