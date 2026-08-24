/**
 * The tray menu's contents, as data.
 *
 * The tray is the only surface left when the window is hidden, so what it offers
 * and what its labels say is behaviour worth testing — which needs it separated
 * from `Tray` and `Menu`.
 */

import { t } from "./strings";

export type StudioTrayCommand = "hide" | "logs" | "quit" | "show";

export type StudioTrayItem =
	| { kind: "separator" }
	| { kind: "command"; id: StudioTrayCommand; label: string }
	| { kind: "checkbox"; checked: boolean; id: "openAtLogin"; label: string };

export interface StudioTrayState {
	/** False on Linux, where Electron cannot register a login item at all. */
	loginItemsSupported: boolean;
	openAtLogin: boolean;
	windowVisible: boolean;
}

/**
 * Resolve the menu for the current state.
 *
 * Show and Hide are one item, not two: two items means one of them is always a
 * no-op, and the user cannot tell from the menu which. The login-item checkbox is
 * omitted rather than disabled where the platform has no such setting, since a
 * checkbox that cannot change is worse than an absent one.
 */
export function resolveStudioTrayMenu(state: StudioTrayState): StudioTrayItem[] {
	const items: StudioTrayItem[] = [
		state.windowVisible
			? { kind: "command", id: "hide", label: t("tray.hide") }
			: { kind: "command", id: "show", label: t("tray.show") },
		{ kind: "separator" },
	];
	if (state.loginItemsSupported) {
		items.push({ kind: "checkbox", checked: state.openAtLogin, id: "openAtLogin", label: t("tray.openAtLogin") });
	}
	items.push(
		{ kind: "command", id: "logs", label: t("tray.logs") },
		{ kind: "separator" },
		{
			kind: "command",
			id: "quit",
			label: t("tray.quit"),
		},
	);
	return items;
}
