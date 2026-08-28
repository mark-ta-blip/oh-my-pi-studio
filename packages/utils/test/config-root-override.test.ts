import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getConfigDirName,
	getProfileRootDir,
	getStudioDbPath,
	getStudioDir,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

describe("OMP_CONFIG_ROOT override", () => {
	let tempRoot = "";
	let originalOmpConfigRoot: string | undefined;
	let originalPiConfigDir: string | undefined;
	let originalOmpProfile: string | undefined;
	let originalPiProfile: string | undefined;
	let originalXdgDataHome: string | undefined;
	let originalXdgStateHome: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalOmpConfigRoot = process.env.OMP_CONFIG_ROOT;
		originalPiConfigDir = process.env.PI_CONFIG_DIR;
		originalOmpProfile = process.env.OMP_PROFILE;
		originalPiProfile = process.env.PI_PROFILE;
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "pi-utils-config-root", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		restoreEnv("OMP_CONFIG_ROOT", originalOmpConfigRoot);
		restoreEnv("PI_CONFIG_DIR", originalPiConfigDir);
		restoreEnv("OMP_PROFILE", originalOmpProfile);
		restoreEnv("PI_PROFILE", originalPiProfile);
		restoreEnv("XDG_DATA_HOME", originalXdgDataHome);
		restoreEnv("XDG_STATE_HOME", originalXdgStateHome);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	/** Rebuild the resolver with a clean env (no profile, no XDG, no other overrides). */
	function activateCleanEnv(overrides: Record<string, string> = {}): void {
		delete process.env.PI_CONFIG_DIR;
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		delete process.env.XDG_DATA_HOME;
		delete process.env.XDG_STATE_HOME;
		delete process.env.XDG_CACHE_HOME;
		for (const [key, value] of Object.entries(overrides)) {
			process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
	}

	it("rebuilds the resolver from OMP_CONFIG_ROOT when it is an absolute path", () => {
		const root = path.join(tempRoot, "state", "omp");
		activateCleanEnv({ OMP_CONFIG_ROOT: root });

		expect(getProfileRootDir(undefined)).toBe(root);
		// Profile roots derive from the overridden base root.
		expect(getProfileRootDir("studio")).toBe(path.join(root, "profiles", "studio"));
	});

	it("relocates the Studio directory and database under the override", () => {
		const root = path.join(tempRoot, "state", "omp");
		activateCleanEnv({ OMP_CONFIG_ROOT: root });

		expect(getStudioDir()).toBe(path.join(root, "studio"));
		expect(getStudioDbPath()).toBe(path.join(root, "studio", "studio.db"));
	});

	it("ignores a relative OMP_CONFIG_ROOT and falls back to the home config dir", () => {
		activateCleanEnv({ OMP_CONFIG_ROOT: "relative/config" });

		expect(getProfileRootDir(undefined)).toBe(path.join(os.homedir(), getConfigDirName()));
	});

	it("ignores an empty OMP_CONFIG_ROOT", () => {
		activateCleanEnv({ OMP_CONFIG_ROOT: "   " });

		expect(getProfileRootDir(undefined)).toBe(path.join(os.homedir(), getConfigDirName()));
	});

	it("wins over PI_CONFIG_DIR when both are set", () => {
		const root = path.join(tempRoot, "state", "omp");
		activateCleanEnv({ OMP_CONFIG_ROOT: root, PI_CONFIG_DIR: "custom" });

		expect(getProfileRootDir(undefined)).toBe(root);
	});
});
