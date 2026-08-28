import { describe, expect, test } from "bun:test";
import { parseStudioDesktopRuntime, type StudioDesktopRuntime } from "../src/client/shell/desktop-runtime";

const RUNTIME: StudioDesktopRuntime = {
	packaged: true,
	platform: "win32",
	sidecarPath: "C:\\app\\resources\\omp-server\\omp.exe",
	storageRoot: "C:\\app\\data",
	logPath: "C:\\app\\data\\logs\\studio-server.log",
	configRoot: null,
	shimDir: null,
	shimInstalled: false,
	shimOnDefaultPath: false,
	shimConflict: false,
	storageRepaired: false,
};

describe("parseStudioDesktopRuntime", () => {
	test("accepts a complete runtime payload", () => {
		expect(parseStudioDesktopRuntime(RUNTIME)).toEqual(RUNTIME);
	});

	test("accepts a relocated root with an installed shim", () => {
		const state = {
			...RUNTIME,
			packaged: false,
			platform: "linux",
			sidecarPath: "/opt/app/resources/omp-server/omp",
			storageRoot: "/home/u/omp-studio",
			logPath: "/home/u/omp-studio/logs/studio-server.log",
			configRoot: "/home/u/omp-studio/omp",
			shimDir: "/home/u/.local/bin",
			shimInstalled: true,
			shimOnDefaultPath: true,
		};
		expect(parseStudioDesktopRuntime(state)).toEqual(state);
	});

	test.each([
		["null", null],
		["undefined", undefined],
		["a string", "ready"],
		["a number", 1],
		["an array", [RUNTIME]],
		["an empty object", {}],
		["a missing platform", { ...RUNTIME, platform: undefined }],
		["an empty sidecarPath", { ...RUNTIME, sidecarPath: "" }],
		["a configRoot that is neither null nor a string", { ...RUNTIME, configRoot: 1 }],
		["a shimDir that is neither null nor a string", { ...RUNTIME, shimDir: 1 }],
		["a non-boolean shimInstalled", { ...RUNTIME, shimInstalled: "yes" }],
		["a non-boolean shimOnDefaultPath", { ...RUNTIME, shimOnDefaultPath: "yes" }],
		["a non-boolean storageRepaired", { ...RUNTIME, storageRepaired: 0 }],
	])("returns null for %s", (_label, value) => {
		// Null degrades to "no Desktop section" rather than rendering paths
		// that a mismatched shell did not send.
		expect(parseStudioDesktopRuntime(value)).toBeNull();
	});
});
