import { describe, expect, test } from "bun:test";
import { t } from "../src/main/strings";
import { resolveStudioTrayMenu, type StudioTrayItem, type StudioTrayState } from "../src/main/tray-menu";

const BASE: StudioTrayState = { loginItemsSupported: true, openAtLogin: false, windowVisible: true };

function labels(items: StudioTrayItem[]): string[] {
	return items.filter(item => item.kind !== "separator").map(item => item.label);
}

describe("resolveStudioTrayMenu", () => {
	test("offers Hide while the window is on screen", () => {
		expect(labels(resolveStudioTrayMenu(BASE))).toEqual([
			t("tray.hide"),
			t("tray.openAtLogin"),
			t("tray.logs"),
			t("tray.quit"),
		]);
	});

	test("offers Show once the window is hidden", () => {
		// One item, not two: with both present one is always a no-op and the menu does
		// not say which.
		expect(labels(resolveStudioTrayMenu({ ...BASE, windowVisible: false }))).toEqual([
			t("tray.show"),
			t("tray.openAtLogin"),
			t("tray.logs"),
			t("tray.quit"),
		]);
	});

	test("reflects the login item's current state in the checkbox", () => {
		const off = resolveStudioTrayMenu(BASE).find(item => item.kind === "checkbox");
		const on = resolveStudioTrayMenu({ ...BASE, openAtLogin: true }).find(item => item.kind === "checkbox");

		expect(off).toEqual({ kind: "checkbox", checked: false, id: "openAtLogin", label: t("tray.openAtLogin") });
		expect(on).toEqual({ kind: "checkbox", checked: true, id: "openAtLogin", label: t("tray.openAtLogin") });
	});

	test("omits the login item where the platform has no such setting", () => {
		// A checkbox that cannot change is worse than an absent one.
		const items = resolveStudioTrayMenu({ ...BASE, loginItemsSupported: false });

		expect(items.some(item => item.kind === "checkbox")).toBe(false);
		expect(labels(items)).toEqual([t("tray.hide"), t("tray.logs"), t("tray.quit")]);
	});

	test("always ends with Quit, so the app is closable with no window", () => {
		for (const windowVisible of [true, false]) {
			for (const loginItemsSupported of [true, false]) {
				const items = resolveStudioTrayMenu({ ...BASE, loginItemsSupported, windowVisible });
				const last = items.at(-1);

				expect(last).toEqual({ kind: "command", id: "quit", label: t("tray.quit") });
			}
		}
	});

	test("reaches the log folder without a window, which is where a failure points", () => {
		const ids = resolveStudioTrayMenu({ ...BASE, windowVisible: false })
			.filter(item => item.kind === "command")
			.map(item => item.id);

		expect(ids).toContain("logs");
	});
});
