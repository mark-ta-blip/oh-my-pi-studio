import { Menu, type NativeImage, nativeImage, Tray } from "electron";
import type { WindowManager } from "./window-manager";

function createTrayIcon(iconPath: string): NativeImage | undefined {
	const icon = nativeImage.createFromPath(iconPath);
	if (!icon.isEmpty()) return icon;
	return undefined;
}

export class TrayManager {
	#tray: Tray | undefined;
	#failure: string | undefined;

	constructor(windowManager: WindowManager, quit: () => void, iconPath: string) {
		const icon = createTrayIcon(iconPath);
		if (!icon) {
			this.#failure = `tray icon missing or unreadable at ${iconPath}`;
			return;
		}
		try {
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
		} catch (error) {
			// Linux desktops without a StatusNotifier host throw here. The caller
			// must not leave close mapped to hide when this happens.
			this.#tray?.destroy();
			this.#tray = undefined;
			this.#failure = error instanceof Error ? error.message : String(error);
		}
	}

	/** False when no tray exists, so hiding the window would leave no way back to it. */
	get available(): boolean {
		return this.#tray !== undefined;
	}

	/** Why the tray is unavailable, for a log line. Undefined once a tray exists. */
	get failure(): string | undefined {
		return this.#failure;
	}

	destroy(): void {
		this.#tray?.destroy();
		this.#tray = undefined;
	}
}
