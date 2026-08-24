import { describe, expect, test } from "bun:test";
import { parseStudioWindowChrome, type StudioWindowChrome } from "../src/client/shell/window-chrome";

const FRAMELESS: StudioWindowChrome = {
	controlsInWindow: true,
	fullScreen: false,
	maximized: false,
	platform: "linux",
};

describe("parseStudioWindowChrome", () => {
	test("accepts a complete state", () => {
		expect(parseStudioWindowChrome(FRAMELESS)).toEqual(FRAMELESS);
	});

	test("accepts a maximized window with native controls", () => {
		const state: StudioWindowChrome = {
			controlsInWindow: false,
			fullScreen: false,
			maximized: true,
			platform: "win32",
		};

		expect(parseStudioWindowChrome(state)).toEqual(state);
	});

	test("drops unknown keys instead of forwarding them into rendering", () => {
		expect(parseStudioWindowChrome({ ...FRAMELESS, sessionPath: "/home/user/project" })).toEqual(FRAMELESS);
	});

	test.each([
		["null", null],
		["undefined", undefined],
		["a string", "maximized"],
		["a number", 1],
		["an array", [FRAMELESS]],
		["an empty object", {}],
		["a missing platform", { controlsInWindow: true, fullScreen: false, maximized: false }],
		["an unknown platform", { ...FRAMELESS, platform: "haiku" }],
		["a non-boolean maximized", { ...FRAMELESS, maximized: "true" }],
		["a non-boolean fullScreen", { ...FRAMELESS, fullScreen: 1 }],
		["a non-boolean controlsInWindow", { ...FRAMELESS, controlsInWindow: null }],
	])("returns null for %s", (_label, value) => {
		// Null degrades to the browser title bar, which is always usable, rather than
		// rendering controls wired to a shell that does not answer for them.
		expect(parseStudioWindowChrome(value)).toBeNull();
	});
});
