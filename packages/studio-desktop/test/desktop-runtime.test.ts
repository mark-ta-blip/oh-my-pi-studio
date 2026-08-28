import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveDesktopRuntimeInfo } from "../src/main/desktop-runtime";
import { createDesktopPaths, type DesktopPaths } from "../src/main/paths";

function makePaths(configRoot: string | undefined): DesktopPaths {
	return createDesktopPaths("/state", "/original", "/resources", "/pkg", configRoot);
}

describe("desktop-runtime", () => {
	it("assembles the full shape for a relocated, shimmed install", () => {
		const info = resolveDesktopRuntimeInfo(
			makePaths("/state/omp"),
			true,
			"linux",
			{ dir: "/home/u/.local/bin", onDefaultPath: true, installed: true, conflict: false },
			false,
		);
		expect(info).toEqual({
			packaged: true,
			platform: "linux",
			sidecarPath: path.join("/resources", "omp-server", "omp"),
			storageRoot: "/state",
			logPath: path.join("/state", "logs", "studio-server.log"),
			configRoot: "/state/omp",
			shimDir: "/home/u/.local/bin",
			shimInstalled: true,
			shimOnDefaultPath: true,
			shimConflict: false,
			storageRepaired: false,
		});
	});

	it("uses the Windows sidecar name on win32 and the bare name elsewhere", () => {
		const windows = resolveDesktopRuntimeInfo(makePaths(undefined), false, "win32", shimOff(), false);
		expect(windows.sidecarPath).toBe(path.join("/resources", "omp-server", "omp.exe"));
		const darwin = resolveDesktopRuntimeInfo(makePaths(undefined), false, "darwin", shimOff(), false);
		expect(darwin.sidecarPath).toBe(path.join("/resources", "omp-server", "omp"));
	});

	it("coerces the optional fields to null when they are absent", () => {
		const info = resolveDesktopRuntimeInfo(makePaths(undefined), false, "darwin", shimOff(), false);
		expect(info.configRoot).toBeNull();
		expect(info.shimDir).toBeNull();
		expect(info.shimOnDefaultPath).toBe(false);
	});

	it("surfaces a shim conflict and a repaired storage fallback", () => {
		const info = resolveDesktopRuntimeInfo(
			makePaths(undefined),
			false,
			"darwin",
			{ dir: "/home/u/.local/bin", onDefaultPath: false, installed: false, conflict: true },
			true,
		);
		expect(info.shimConflict).toBe(true);
		expect(info.shimInstalled).toBe(false);
		expect(info.shimDir).toBeNull();
		expect(info.storageRepaired).toBe(true);
	});
});

function shimOff() {
	return { dir: null, onDefaultPath: false, installed: false, conflict: false };
}
