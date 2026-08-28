import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createPackage, listPackage } from "@electron/asar";
import afterPack, { assertPackagedTree, sidecarName } from "../scripts/after-pack.cjs";

/**
 * Build a minimal but complete packaged tree: an extraResources dir holding the
 * sidecar and tray icon, and an app.asar holding the two bundled scripts. The
 * real asar module is used so the listing matches what the builder produces.
 */
async function buildTree(
	root: string,
	parts: { sidecar: boolean; tray: boolean; asarEntries: string[]; foreignSidecar?: boolean },
): Promise<string> {
	const resourcesDir = path.join(root, "resources");
	await fs.mkdir(path.join(resourcesDir, "omp-server"), { recursive: true });
	if (parts.sidecar) await fs.writeFile(path.join(resourcesDir, "omp-server", "omp.exe"), "x", "utf8");
	if (parts.foreignSidecar) await fs.writeFile(path.join(resourcesDir, "omp-server", "omp"), "x", "utf8");
	if (parts.tray) await fs.writeFile(path.join(resourcesDir, "tray-icon.png"), "x", "utf8");

	// Staging dir for the asar contents, then package it in place.
	const staging = path.join(root, "asar-staging");
	for (const entry of parts.asarEntries) {
		await fs.mkdir(path.dirname(path.join(staging, entry)), { recursive: true });
		await fs.writeFile(path.join(staging, entry), "x", "utf8");
	}
	const asarPath = path.join(resourcesDir, "app.asar");
	await createPackage(staging, asarPath);
	return asarPath;
}

describe("after-pack assertPackagedTree", () => {
	let root = "";

	beforeEach(async () => {
		root = path.join(os.tmpdir(), `after-pack-${Math.floor(Math.random() * 1e9)}`);
		await fs.mkdir(root, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const full = { sidecar: true, tray: true, asarEntries: ["dist/main/index.js", "dist/preload/index.cjs"] };

	it("passes on a complete tree", async () => {
		const asarPath = await buildTree(root, full);
		await expect(
			assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "win32" }),
		).resolves.toBeUndefined();
	});

	it("throws naming the missing sidecar", async () => {
		const asarPath = await buildTree(root, { ...full, sidecar: false });
		await expect(
			assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "win32" }),
		).rejects.toThrow(/omp\.exe/);
	});

	it("throws naming a foreign-architecture sidecar", async () => {
		// A leftover POSIX `omp` beside the win32 `omp.exe` means a
		// cross-architecture contamination the build must not ship.
		const asarPath = await buildTree(root, { ...full, foreignSidecar: true });
		await expect(
			assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "win32" }),
		).rejects.toThrow(/foreign-architecture sidecar omp/);
	});

	it("passes when only the platform-matched sidecar is present", async () => {
		const asarPath = await buildTree(root, full);
		await expect(
			assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "win32" }),
		).resolves.toBeUndefined();
	});

	it("throws naming the missing tray icon", async () => {
		const asarPath = await buildTree(root, { ...full, tray: false });
		await expect(
			assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "win32" }),
		).rejects.toThrow(/tray icon/);
	});

	it("throws naming a missing asar entry", async () => {
		const asarPath = await buildTree(root, { ...full, asarEntries: ["dist/main/index.js"] });
		await expect(
			assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "win32" }),
		).rejects.toThrow(/dist\/preload\/index\.cjs/);
	});

	it("names every missing piece in a single error", async () => {
		const asarPath = await buildTree(root, { ...full, sidecar: false, tray: false, asarEntries: [] });
		let message = "";
		try {
			await assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "win32" });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("omp.exe");
		expect(message).toContain("tray icon");
		expect(message).toContain("dist/main/index.js");
		expect(message).toContain("dist/preload/index.cjs");
	});

	it("checks the POSIX sidecar name on non-Windows platforms", async () => {
		const asarPath = await buildTree(root, full);
		// The win32-named sidecar satisfies only win32; a darwin check looks for `omp`.
		await expect(
			assertPackagedTree({ resourcesDir: path.join(root, "resources"), asarPath, platform: "darwin" }),
		).rejects.toThrow(/omp /);
	});

	it("picks the sidecar name per platform", () => {
		expect(sidecarName("win32")).toBe("omp.exe");
		expect(sidecarName("darwin")).toBe("omp");
		expect(sidecarName("linux")).toBe("omp");
	});
});

describe("after-pack hook context resolution", () => {
	/**
	 * Build a complete packaged tree under `root` in the layout electron-builder
	 * assembles for `platform`: `<appOutDir>/resources/` on win/linux,
	 * `<appOutDir>/<productFilename>.app/Contents/Resources/` on darwin — where
	 * appOutDir *contains* the .app, matching app-builder-lib's
	 * getMacOsResourcesDir.
	 */
	async function buildContextTree(
		appOutDir: string,
		platform: "win32" | "darwin",
		productFilename = "OMP Studio",
	): Promise<void> {
		const resourcesDir =
			platform === "darwin"
				? path.join(appOutDir, `${productFilename}.app`, "Contents", "Resources")
				: path.join(appOutDir, "resources");
		await fs.mkdir(path.join(resourcesDir, "omp-server"), { recursive: true });
		await fs.writeFile(path.join(resourcesDir, "omp-server", sidecarName(platform)), "x", "utf8");
		await fs.writeFile(path.join(resourcesDir, "tray-icon.png"), "x", "utf8");

		const staging = path.join(appOutDir, "asar-staging");
		for (const entry of ["dist/main/index.js", "dist/preload/index.cjs"]) {
			await fs.mkdir(path.dirname(path.join(staging, entry)), { recursive: true });
			await fs.writeFile(path.join(staging, entry), "x", "utf8");
		}
		await createPackage(staging, path.join(resourcesDir, "app.asar"));
	}

	function mockContext(appOutDir: string, platform: "win32" | "darwin", productFilename = "OMP Studio") {
		return {
			appOutDir,
			electronPlatformName: platform,
			packager: { appInfo: { productFilename } },
		};
	}

	it("resolves the macOS resources directory inside the .app bundle", async () => {
		// Regression: the hook once dropped the .app segment, so every darwin
		// leg failed its own afterPack check on a correctly assembled tree.
		const appOutDir = path.join(os.tmpdir(), `after-pack-mac-${Math.floor(Math.random() * 1e9)}`);
		await buildContextTree(appOutDir, "darwin");
		try {
			await expect(afterPack(mockContext(appOutDir, "darwin"))).resolves.toBeUndefined();
		} finally {
			await fs.rm(appOutDir, { recursive: true, force: true });
		}
	});

	it("resolves the non-macOS resources directory directly under appOutDir", async () => {
		const appOutDir = path.join(os.tmpdir(), `after-pack-win-${Math.floor(Math.random() * 1e9)}`);
		await buildContextTree(appOutDir, "win32");
		try {
			await expect(afterPack(mockContext(appOutDir, "win32"))).resolves.toBeUndefined();
		} finally {
			await fs.rm(appOutDir, { recursive: true, force: true });
		}
	});

	it("still fails on an incomplete darwin tree via the hook", async () => {
		const appOutDir = path.join(os.tmpdir(), `after-pack-mac-bad-${Math.floor(Math.random() * 1e9)}`);
		await buildContextTree(appOutDir, "darwin");
		// Delete the sidecar from the .app bundle: the hook must report it.
		await fs.rm(path.join(appOutDir, "OMP Studio.app", "Contents", "Resources", "omp-server", "omp"), { force: true });
		try {
			await expect(afterPack(mockContext(appOutDir, "darwin"))).rejects.toThrow(/omp-server/);
		} finally {
			await fs.rm(appOutDir, { recursive: true, force: true });
		}
	});
});

describe("asar listing format", () => {
	it("normalizes separators so the asar check is portable", async () => {
		const root = path.join(os.tmpdir(), `asar-sep-${Math.floor(Math.random() * 1e9)}`);
		const staging = path.join(root, "staging");
		await fs.mkdir(path.join(staging, "dist", "main"), { recursive: true });
		await fs.writeFile(path.join(staging, "dist", "main", "index.js"), "x", "utf8");
		const asarPath = path.join(root, "app.asar");
		await createPackage(staging, asarPath);
		const entries = listPackage(asarPath).map(entry => entry.replace(/\\/g, "/").replace(/^\//, ""));
		expect(entries).toContain("dist/main/index.js");
		await fs.rm(root, { recursive: true, force: true });
	});
});
