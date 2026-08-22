import { expect, test } from "bun:test";
import { isStudioQuitRequest, parseStudioDesktopArgs } from "../src/main/instance-args";
import { isStudioIpcSender } from "../src/main/ipc-sender";

function fakeWindow(webContents: unknown, destroyed = false) {
	return { isDestroyed: () => destroyed, webContents };
}

test("accepts the Studio window's own sender and refuses everything else", () => {
	const webContents = { id: 1 };
	const window = fakeWindow(webContents);

	expect(isStudioIpcSender(webContents, window)).toBe(true);
	expect(isStudioIpcSender({ id: 2 }, window)).toBe(false);
	expect(isStudioIpcSender(webContents, null)).toBe(false);
	expect(isStudioIpcSender(webContents, undefined)).toBe(false);
});

test("refuses a sender whose window has been destroyed", () => {
	const webContents = { id: 1 };

	// A destroyed window can still compare equal while the window is gone.
	expect(isStudioIpcSender(webContents, fakeWindow(webContents, true))).toBe(false);
});

test("parses the desktop switches independently of their order", () => {
	expect(parseStudioDesktopArgs(["omp-studio.exe"])).toEqual({
		hidden: false,
		quitExisting: false,
		smokeTest: false,
	});
	expect(parseStudioDesktopArgs(["omp-studio.exe", "--quit", "--hidden", "--smoke-test"])).toEqual({
		hidden: true,
		quitExisting: true,
		smokeTest: true,
	});
});

test("treats only an explicit quit payload from a second instance as a quit request", () => {
	expect(isStudioQuitRequest(["omp-studio.exe", "--quit"], undefined)).toBe(true);
	expect(isStudioQuitRequest([], { quit: true })).toBe(true);
	expect(isStudioQuitRequest([], { quit: "true" })).toBe(false);
	expect(isStudioQuitRequest([], { quit: 1 })).toBe(false);
	expect(isStudioQuitRequest([], [{ quit: true }])).toBe(false);
	expect(isStudioQuitRequest([], "quit")).toBe(false);
	expect(isStudioQuitRequest([], null)).toBe(false);
	expect(isStudioQuitRequest([], {})).toBe(false);
});
