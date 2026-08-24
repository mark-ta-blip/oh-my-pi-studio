import { describe, expect, test } from "bun:test";
import { resolveStudioContextMenu } from "../src/main/context-menu";
import { t } from "../src/main/strings";

const ALL_FLAGS = { canCopy: true, canCut: true, canPaste: true, canSelectAll: true };

describe("resolveStudioContextMenu", () => {
	test("offers nothing when a click would produce an empty menu", () => {
		// Right-clicking blank space: a menu of greyed-out entries is worse than none.
		expect(resolveStudioContextMenu({ editFlags: ALL_FLAGS })).toEqual([]);
	});

	test("offers copy and select-all on selected read-only text", () => {
		expect(resolveStudioContextMenu({ editFlags: ALL_FLAGS, selectionText: "run failed" })).toEqual([
			{ kind: "role", role: "copy" },
			{ kind: "role", role: "selectAll" },
		]);
	});

	test("offers the full edit set in a field with a selection", () => {
		expect(resolveStudioContextMenu({ editFlags: ALL_FLAGS, isEditable: true, selectionText: "prompt" })).toEqual([
			{ kind: "role", role: "cut" },
			{ kind: "role", role: "copy" },
			{ kind: "role", role: "paste" },
			{ kind: "role", role: "selectAll" },
		]);
	});

	test("offers paste in an empty field, but not cut or copy", () => {
		expect(resolveStudioContextMenu({ editFlags: ALL_FLAGS, isEditable: true })).toEqual([
			{ kind: "role", role: "paste" },
			{ kind: "role", role: "selectAll" },
		]);
	});

	test("omits an item Chromium reports as unavailable", () => {
		expect(
			resolveStudioContextMenu({
				editFlags: { canCopy: false, canPaste: false, canSelectAll: false },
				isEditable: true,
				selectionText: "locked",
			}),
		).toEqual([{ kind: "role", role: "cut" }]);
	});

	test("separates the link entry from the edit entries", () => {
		expect(
			resolveStudioContextMenu({
				editFlags: ALL_FLAGS,
				linkURL: "https://omp.sh/docs",
				selectionText: "docs",
			}),
		).toEqual([
			{ kind: "role", role: "copy" },
			{ kind: "role", role: "selectAll" },
			{ kind: "separator" },
			{ kind: "copyLink", label: t("menu.copyLink"), url: "https://omp.sh/docs" },
		]);
	});

	test("offers a link on its own without a leading separator", () => {
		expect(resolveStudioContextMenu({ linkURL: "http://127.0.0.1:7777/api" })).toEqual([
			{ kind: "copyLink", label: t("menu.copyLink"), url: "http://127.0.0.1:7777/api" },
		]);
	});

	test.each([
		["javascript", "javascript:alert(1)"],
		["file", "file:///C:/Windows/System32/cmd.exe"],
		["data", "data:text/html,<script>alert(1)</script>"],
		["a relative path", "/api/v1/bootstrap"],
		["empty", ""],
	])("refuses to put a %s URL on the clipboard", (_label, linkURL) => {
		// Copying it is the first half of an attack that ends with the user pasting it
		// somewhere that runs it.
		expect(resolveStudioContextMenu({ linkURL })).toEqual([]);
	});

	test("treats whitespace-only selection as no selection", () => {
		expect(resolveStudioContextMenu({ editFlags: ALL_FLAGS, selectionText: "   \n  " })).toEqual([]);
	});

	test("assumes an item is available when Chromium reports no flags", () => {
		expect(resolveStudioContextMenu({ selectionText: "text" })).toEqual([
			{ kind: "role", role: "copy" },
			{ kind: "role", role: "selectAll" },
		]);
	});
});
