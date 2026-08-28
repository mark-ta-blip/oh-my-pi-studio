import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearDesktopStorageSettings,
	type DesktopStorageSettings,
	defaultConfigRoot,
	hasMigratedConfig,
	hasMigratedState,
	migrateConfigRoot,
	migrateDesktopState,
	parseDesktopStorageSettings,
	probeWritableDir,
	readDesktopStorageSettings,
	resolveEffectiveStorage,
	writeDesktopStorageSettings,
} from "../src/main/desktop-storage";

const POSIX_ROOT = "/tmp/omp-studio-state";
const WIN_ROOT = "C:\\omp-studio-state";

function tempRoot(): string {
	return path.join(os.tmpdir(), `desktop-storage-${Math.floor(Math.random() * 1e9)}`);
}

describe("desktop-storage", () => {
	let root = "";

	beforeEach(async () => {
		root = tempRoot();
		await fs.mkdir(root, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const accept: DesktopStorageSettings = { stateRoot: process.platform === "win32" ? WIN_ROOT : POSIX_ROOT };

	it("accepts a well-formed absolute state root", () => {
		expect(parseDesktopStorageSettings(JSON.stringify(accept))).toEqual(accept);
	});

	it("validates absolute-ness for an explicit platform, off the host OS", () => {
		// Windows: a drive-letter root is absolute, in either separator style;
		// a drive-relative or a POSIX path is not.
		expect(parseDesktopStorageSettings(JSON.stringify({ stateRoot: WIN_ROOT }), "win32")).toEqual({
			stateRoot: WIN_ROOT,
		});
		expect(parseDesktopStorageSettings(JSON.stringify({ stateRoot: "C:/omp" }), "win32")).toEqual({
			stateRoot: "C:/omp",
		});
		expect(parseDesktopStorageSettings(JSON.stringify({ stateRoot: "C:drive-relative" }), "win32")).toBeNull();
		expect(parseDesktopStorageSettings(JSON.stringify({ stateRoot: POSIX_ROOT }), "win32")).toBeNull();

		// POSIX: a root-anchored path is absolute; a drive-letter path is not.
		expect(parseDesktopStorageSettings(JSON.stringify({ stateRoot: POSIX_ROOT }), "linux")).toEqual({
			stateRoot: POSIX_ROOT,
		});
		expect(parseDesktopStorageSettings(JSON.stringify({ stateRoot: WIN_ROOT }), "linux")).toBeNull();
		expect(parseDesktopStorageSettings(JSON.stringify({ stateRoot: "relative/path" }), "linux")).toBeNull();
	});

	it("round-trips through the file", async () => {
		const settingsPath = path.join(root, "desktop-settings.json");
		await writeDesktopStorageSettings(settingsPath, accept);
		expect(await readDesktopStorageSettings(settingsPath)).toEqual(accept);
		await clearDesktopStorageSettings(settingsPath);
		expect(await readDesktopStorageSettings(settingsPath)).toBeNull();
	});

	it("clear tolerates a missing settings file", async () => {
		await expect(
			clearDesktopStorageSettings(path.join(root, "nope", "desktop-settings.json")),
		).resolves.toBeUndefined();
	});

	it("rejects malformed and unsafe settings", async () => {
		const bad = [
			"not json",
			JSON.stringify({}),
			JSON.stringify({ stateRoot: 1 }),
			JSON.stringify({ stateRoot: "   " }),
			JSON.stringify({ stateRoot: "relative/path" }),
			JSON.stringify({ stateRoot: "C:drive-relative" }),
			JSON.stringify({ stateRoot: `${POSIX_ROOT}\0` }),
			JSON.stringify({ stateRoot: "x".repeat(5000) }),
			JSON.stringify({}),
		];
		for (const raw of bad) {
			const settingsPath = path.join(root, "bad.json");
			await fs.writeFile(settingsPath, raw, "utf8");
			expect(await readDesktopStorageSettings(settingsPath)).toBeNull();
		}
	});

	it("probeWritableDir is true for a real dir and false for a path under a file", async () => {
		const dir = path.join(root, "writable");
		expect(await probeWritableDir(dir)).toBe(true);
		const file = path.join(root, "a-file");
		await fs.writeFile(file, "x", "utf8");
		expect(await probeWritableDir(path.join(file, "sub"))).toBe(false);
	});

	it("hasMigratedState reports presence of window-state.json", async () => {
		const stateRoot = path.join(root, "state");
		expect(await hasMigratedState(stateRoot)).toBe(false);
		await fs.mkdir(stateRoot, { recursive: true });
		await fs.writeFile(path.join(stateRoot, "window-state.json"), "{}", "utf8");
		expect(await hasMigratedState(stateRoot)).toBe(true);
	});

	it("migrates window-state.json and logs/, and never clobbers existing target state", async () => {
		const from = path.join(root, "from");
		const to = path.join(root, "to");
		await fs.mkdir(path.join(from, "logs"), { recursive: true });
		await fs.writeFile(path.join(from, "window-state.json"), '{"width":1}', "utf8");
		await fs.writeFile(path.join(from, "logs", "studio-server.log"), "line\n", "utf8");
		// Target already holds newer state for one entry.
		await fs.mkdir(path.join(to, "logs"), { recursive: true });
		await fs.writeFile(path.join(to, "window-state.json"), '{"width":2}', "utf8");

		await migrateDesktopState(from, to);

		expect(await fs.readFile(path.join(to, "window-state.json"), "utf8")).toBe('{"width":2}');
		expect(await fs.readFile(path.join(to, "logs", "studio-server.log"), "utf8")).toBe("line\n");
	});

	it("migrating from a missing source does not throw", async () => {
		await expect(migrateDesktopState(path.join(root, "absent"), path.join(root, "to"))).resolves.toBeUndefined();
	});

	it("resolves the default config root from OMP_CONFIG_ROOT, PI_CONFIG_DIR, or .omp under home", () => {
		expect(defaultConfigRoot({})).toBe(path.join(os.homedir(), ".omp"));
		expect(defaultConfigRoot({ PI_CONFIG_DIR: ".custom" })).toBe(path.join(os.homedir(), ".custom"));
		// OMP_CONFIG_ROOT is the override the sidecar itself honors, so the
		// migration source must match it; it wins over PI_CONFIG_DIR and is
		// ignored when empty or not absolute on the host platform.
		const absRoot = process.platform === "win32" ? "C:\\omp-state\\omp" : "/omp-state/omp";
		expect(defaultConfigRoot({ OMP_CONFIG_ROOT: absRoot })).toBe(absRoot);
		expect(defaultConfigRoot({ OMP_CONFIG_ROOT: absRoot, PI_CONFIG_DIR: ".custom" })).toBe(absRoot);
		expect(defaultConfigRoot({ OMP_CONFIG_ROOT: "relative/omp" })).toBe(path.join(os.homedir(), ".omp"));
		expect(defaultConfigRoot({ OMP_CONFIG_ROOT: "   " })).toBe(path.join(os.homedir(), ".omp"));
	});

	it("hasMigratedConfig requires the config dir to exist and be non-empty", async () => {
		const configDir = path.join(root, "config");
		expect(await hasMigratedConfig(configDir)).toBe(false);
		await fs.mkdir(configDir, { recursive: true });
		expect(await hasMigratedConfig(configDir)).toBe(false);
		await fs.writeFile(path.join(configDir, "sessions.json"), "[]", "utf8");
		expect(await hasMigratedConfig(configDir)).toBe(true);
	});

	it("migrates the OMP config into <stateRoot>/omp and never clobbers it", async () => {
		const from = path.join(root, "omp-src");
		await fs.mkdir(from, { recursive: true });
		await fs.writeFile(path.join(from, "settings.json"), '{"a":1}', "utf8");
		await fs.writeFile(path.join(from, "sub.txt"), "x", "utf8");
		const stateRoot = path.join(root, "state");
		// Target already holds a newer version of one entry.
		await fs.mkdir(path.join(stateRoot, "omp"), { recursive: true });
		await fs.writeFile(path.join(stateRoot, "omp", "settings.json"), '{"a":2}', "utf8");

		await migrateConfigRoot(from, stateRoot);

		expect(await fs.readFile(path.join(stateRoot, "omp", "settings.json"), "utf8")).toBe('{"a":2}');
		expect(await fs.readFile(path.join(stateRoot, "omp", "sub.txt"), "utf8")).toBe("x");
	});

	it("migrating a config from a missing source does not throw", async () => {
		await expect(migrateConfigRoot(path.join(root, "absent"), path.join(root, "state"))).resolves.toBeUndefined();
	});

	it("uses the saved root when writable and reports repaired when it is not", () => {
		const defaultDir = path.join(root, "default");
		expect(resolveEffectiveStorage(defaultDir, accept, true)).toEqual({
			userDataDir: accept.stateRoot,
			repaired: false,
		});
		expect(resolveEffectiveStorage(defaultDir, accept, false)).toEqual({
			userDataDir: defaultDir,
			repaired: true,
		});
		expect(resolveEffectiveStorage(defaultDir, null, false)).toEqual({
			userDataDir: defaultDir,
			repaired: false,
		});
	});
});
