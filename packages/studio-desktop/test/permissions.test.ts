import { describe, expect, test } from "bun:test";
import { isStudioPermissionAllowed } from "../src/main/permissions";

/** The requests that would matter most if the default were wrong. */
const PERMISSIONS = [
	"media",
	"geolocation",
	"notifications",
	"clipboard-read",
	"clipboard-sanitized-write",
	"display-capture",
	"midi",
	"midiSysex",
	"pointerLock",
	"openExternal",
	"fullscreen",
	"hid",
	"serial",
	"usb",
	"window-management",
	"unknown-future-permission",
	"",
];

describe("isStudioPermissionAllowed", () => {
	test.each(PERMISSIONS)("denies %p from an unexpected renderer", permission => {
		// The case an embedded browser or a stray WebContentsView would land in: a
		// renderer this shell did not create gets nothing, whatever it asks for.
		expect(isStudioPermissionAllowed({ fromStudioRenderer: false, permission })).toBe(false);
	});

	test.each(PERMISSIONS)("denies %p from the Studio window too", permission => {
		// Nothing has been enabled yet. Phase 17 is what adds `media` here, and this
		// test is what will fail if a permission is granted without a phase behind it.
		expect(isStudioPermissionAllowed({ fromStudioRenderer: true, permission })).toBe(false);
	});
});
