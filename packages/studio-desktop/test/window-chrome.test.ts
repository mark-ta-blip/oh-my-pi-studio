import { describe, expect, test } from "bun:test";
import {
	parseWindowControlAction,
	resolveWindowChromeOptions,
	resolveWindowChromePlatform,
	TITLEBAR_HEIGHT,
	TITLEBAR_OVERLAY_COLOR,
	TITLEBAR_OVERLAY_SYMBOL_COLOR,
	type WindowControlAction,
	windowControlsAreDrawnInWindow,
} from "../src/main/window-chrome";

describe("parseWindowControlAction", () => {
	test.each<WindowControlAction>(["close", "minimize", "toggle-maximize"])("accepts %s", action => {
		expect(parseWindowControlAction(action)).toBe(action);
	});

	test.each([
		["an unknown action", "destroy"],
		["a near miss", "maximize"],
		["different casing", "Close"],
		["surrounding whitespace", " close "],
		["an empty string", ""],
		["a number", 1],
		["a boolean", true],
		["null", null],
		["undefined", undefined],
		["an object", { action: "close" }],
		["an array", ["close"]],
	])("rejects %s", (_label, value) => {
		expect(parseWindowControlAction(value)).toBeUndefined();
	});

	test("rejects an inherited property name", () => {
		// A Set lookup rather than an object index, so prototype keys are not actions.
		expect(parseWindowControlAction("toString")).toBeUndefined();
		expect(parseWindowControlAction("constructor")).toBeUndefined();
	});
});

describe("resolveWindowChromePlatform", () => {
	test.each([
		["win32", "win32"],
		["darwin", "darwin"],
		["linux", "linux"],
	])("passes %s through", (platform, expected) => {
		expect(resolveWindowChromePlatform(platform)).toBe(expected);
	});

	test.each(["freebsd", "aix", "", "WIN32"])("maps %p to other", platform => {
		expect(resolveWindowChromePlatform(platform)).toBe("other");
	});
});

describe("resolveWindowChromeOptions", () => {
	test("hides the Windows title bar but keeps its caption buttons", () => {
		expect(resolveWindowChromeOptions("win32")).toEqual({
			titleBarStyle: "hidden",
			titleBarOverlay: {
				color: TITLEBAR_OVERLAY_COLOR,
				height: TITLEBAR_HEIGHT,
				symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
			},
		});
	});

	test("insets the macOS traffic lights and enables the overlay variables", () => {
		expect(resolveWindowChromeOptions("darwin")).toEqual({ titleBarStyle: "hiddenInset", titleBarOverlay: true });
	});

	test.each(["linux", "freebsd"])("makes %s plainly frameless", platform => {
		expect(resolveWindowChromeOptions(platform)).toEqual({ frame: false });
	});

	test("never sets frame and titleBarStyle at once", () => {
		for (const platform of ["win32", "darwin", "linux", "freebsd"]) {
			const options = resolveWindowChromeOptions(platform);
			expect(options.frame === false && options.titleBarStyle !== undefined).toBe(false);
		}
	});

	test("keeps the overlay height matching the rendered title bar", () => {
		// The overlay is drawn over the client area, so a height that disagrees with
		// `.studio-desktop-shell .studio-titlebar` puts the buttons outside it.
		expect(TITLEBAR_HEIGHT).toBe(56);
	});
});

describe("windowControlsAreDrawnInWindow", () => {
	test.each([
		["win32", false],
		["darwin", false],
		["linux", true],
		["freebsd", true],
	])("is %s -> %p", (platform, expected) => {
		expect(windowControlsAreDrawnInWindow(platform)).toBe(expected);
	});
});
