/**
 * The right-click menu for text and links.
 *
 * A frameless window with no application menu has no other route to copy and
 * paste on Windows and Linux, so this is not a convenience. The resolution is a
 * pure function over the parameters Electron reports, so the rules are testable
 * without opening a menu.
 */

import { resolveExternalHttpUrl } from "./external-url";
import { t } from "./strings";

/** Descriptors rather than Electron menu items, so this module stays pure. */
export type StudioContextMenuItem =
	| { kind: "separator" }
	| { kind: "role"; role: "copy" | "cut" | "paste" | "selectAll" }
	| { kind: "copyLink"; label: string; url: string };

/** The subset of Electron's `ContextMenuParams` the rules read. */
export interface StudioContextMenuParams {
	editFlags?: {
		canCopy?: boolean;
		canCut?: boolean;
		canPaste?: boolean;
		canSelectAll?: boolean;
	};
	isEditable?: boolean;
	linkURL?: string;
	selectionText?: string;
}

/**
 * Build the menu for a right click, or nothing at all.
 *
 * Items appear only when they would do something: no "Copy" on an empty
 * selection, no "Paste" outside an editable field. An empty result means no menu
 * is shown, which is better than a menu of greyed-out entries.
 *
 * Roles carry the OS's own localized labels, so only the link entry needs a
 * string of ours. The link URL is validated the same way an external launch is —
 * copying a `javascript:` or `file:` URL to the clipboard is the first half of an
 * attack that ends with the user pasting it somewhere that runs it.
 */
export function resolveStudioContextMenu(params: StudioContextMenuParams): StudioContextMenuItem[] {
	const flags = params.editFlags ?? {};
	const items: StudioContextMenuItem[] = [];
	const hasSelection = (params.selectionText ?? "").trim().length > 0;
	if (params.isEditable === true && flags.canCut !== false && hasSelection) items.push({ kind: "role", role: "cut" });
	if (hasSelection && flags.canCopy !== false) items.push({ kind: "role", role: "copy" });
	if (params.isEditable === true && flags.canPaste !== false) items.push({ kind: "role", role: "paste" });
	if (flags.canSelectAll !== false && (params.isEditable === true || hasSelection)) {
		items.push({ kind: "role", role: "selectAll" });
	}
	const url = params.linkURL === undefined ? null : resolveExternalHttpUrl(params.linkURL);
	if (url !== null) {
		if (items.length > 0) items.push({ kind: "separator" });
		items.push({ kind: "copyLink", label: t("menu.copyLink"), url });
	}
	return items;
}
