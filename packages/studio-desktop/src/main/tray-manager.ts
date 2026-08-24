import { Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, Tray } from "electron";
import { resolveStudioTrayMenu, type StudioTrayCommand, type StudioTrayState } from "./tray-menu";

function createTrayIcon(iconPath: string): NativeImage | undefined {
	const icon = nativeImage.createFromPath(iconPath);
	if (!icon.isEmpty()) return icon;
	return undefined;
}

/** What the tray can do. Every entry is reachable with no window on screen. */
export interface TrayActions {
	hide(): void;
	openLogFolder(): void;
	quit(): void;
	setOpenAtLogin(enabled: boolean): void;
	show(): void;
}

export interface TrayManagerOptions {
	actions: TrayActions;
	iconPath: string;
	/** Read fresh on every rebuild, so the menu cannot show stale state. */
	state(): StudioTrayState;
}

export class TrayManager {
	#tray: Tray | undefined;
	#failure: string | undefined;
	readonly #options: TrayManagerOptions;

	constructor(options: TrayManagerOptions) {
		this.#options = options;
		const icon = createTrayIcon(options.iconPath);
		if (!icon) {
			this.#failure = `tray icon missing or unreadable at ${options.iconPath}`;
			return;
		}
		try {
			this.#tray = new Tray(icon);
			this.#tray.setToolTip("OMP Studio");
			this.refresh();
			this.#tray.on("double-click", () => options.actions.show());
		} catch (error) {
			// Linux desktops without a StatusNotifier host throw here. The caller
			// must not leave close mapped to hide when this happens.
			this.#tray?.destroy();
			this.#tray = undefined;
			this.#failure = error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * Rebuild the menu from current state.
	 *
	 * Electron takes a built menu rather than a callback, so a state change — the
	 * window being hidden, the login item being toggled — has to be pushed here or
	 * the menu keeps describing the old state.
	 */
	refresh(): void {
		const tray = this.#tray;
		if (!tray || tray.isDestroyed()) return;
		const { actions } = this.#options;
		// One entry per command id, so adding an id to the menu without wiring it here
		// is a type error rather than a menu item that does nothing.
		const commands: Record<StudioTrayCommand, () => void> = {
			hide: () => actions.hide(),
			logs: () => actions.openLogFolder(),
			quit: () => actions.quit(),
			show: () => actions.show(),
		};
		const template = resolveStudioTrayMenu(this.#options.state()).map((item): MenuItemConstructorOptions => {
			if (item.kind === "separator") return { type: "separator" };
			if (item.kind === "checkbox") {
				return {
					type: "checkbox",
					label: item.label,
					checked: item.checked,
					click: menuItem => actions.setOpenAtLogin(menuItem.checked),
				};
			}
			return { label: item.label, click: commands[item.id] };
		});
		tray.setContextMenu(Menu.buildFromTemplate(template));
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
