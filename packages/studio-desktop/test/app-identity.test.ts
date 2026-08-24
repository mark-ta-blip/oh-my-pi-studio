import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { APP_USER_MODEL_ID, loginItemsAreSupported, resolveLoginItemSettings } from "../src/main/app-identity";

const EXEC_PATH = "C:\\Program Files\\OMP Studio\\OMP Studio.exe";

describe("APP_USER_MODEL_ID", () => {
	test("matches the appId the installer stamps on the shortcut", async () => {
		// A mismatch is invisible at runtime and drops every Windows notification, so
		// the two declarations are compared rather than trusted to stay in step.
		const configPath = path.join(import.meta.dir, "..", "electron-builder.yml");
		const config = await Bun.file(configPath).text();
		const appId = /^appId:\s*(\S+)\s*$/m.exec(config)?.[1];

		expect(appId).toBe(APP_USER_MODEL_ID);
	});
});

describe("loginItemsAreSupported", () => {
	test.each([
		["win32", true],
		["darwin", true],
		["linux", false],
		["freebsd", false],
	])("is %s -> %p", (platform, expected) => {
		expect(loginItemsAreSupported(platform)).toBe(expected);
	});
});

describe("resolveLoginItemSettings", () => {
	test("starts hidden on Windows, naming the executable to register", () => {
		expect(resolveLoginItemSettings("win32", EXEC_PATH, true)).toEqual({
			openAtLogin: true,
			path: EXEC_PATH,
			args: ["--hidden"],
		});
	});

	test("keeps the executable when disabling, so the right entry is removed", () => {
		expect(resolveLoginItemSettings("win32", EXEC_PATH, false)).toEqual({
			openAtLogin: false,
			path: EXEC_PATH,
			args: ["--hidden"],
		});
	});

	test("uses the macOS hidden-launch flag, which takes no arguments", () => {
		expect(resolveLoginItemSettings("darwin", "/Applications/OMP Studio.app", true)).toEqual({
			openAtLogin: true,
			openAsHidden: true,
		});
	});

	test("passes nothing platform-specific elsewhere", () => {
		expect(resolveLoginItemSettings("linux", "/usr/bin/omp-studio", true)).toEqual({ openAtLogin: true });
	});

	test("always requests a hidden start, never a visible one", () => {
		// The user asked for Studio to be running at login, not to have it take the
		// foreground on every boot.
		for (const platform of ["win32", "darwin"]) {
			const settings = resolveLoginItemSettings(platform, EXEC_PATH, true);
			expect(settings.args?.includes("--hidden") === true || settings.openAsHidden === true).toBe(true);
		}
	});
});
