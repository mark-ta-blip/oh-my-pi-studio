/**
 * electron-builder `afterPack` hook: fail the build fast when a packaged tree is
 * incomplete.
 *
 * The sidecar, the tray icon, and the two bundled scripts must all be in the
 * assembled app before it is signed or published, because a missing sidecar is
 * only discovered the first time a user launches the installer. This hook makes
 * that a build error instead of a release-page one.
 *
 * The pure check is exported separately so it is testable without running
 * electron-builder: `assertPackagedTree` takes the two locations it inspects and
 * throws naming every missing piece. The hook below just resolves those
 * locations from the builder's `context` and calls it.
 */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const asar = require("@electron/asar");

/** The sidecar executable name for a given platform. */
function sidecarName(platform) {
	return platform === "win32" ? "omp.exe" : "omp";
}

/** The two bundled scripts that must be inside app.asar. */
const REQUIRED_ASAR_ENTRIES = ["dist/main/index.js", "dist/preload/index.cjs"];

/**
 * Verify a packaged tree is complete: the platform-matched sidecar and tray
 * icon are present, the foreign-architecture sidecar is absent, and the two
 * bundled scripts are inside app.asar. Returns nothing on success and throws
 * an error listing *every* problem (not just the first) so one build reports
 * the whole gap.
 *
 * `resourcesDir` is the unpacked app's resources directory (`resources/` on
 * win/linux, `Contents/Resources/` on mac), holding both the extraResources and
 * `app.asar`.
 */
async function assertPackagedTree({ resourcesDir, asarPath, platform }) {
	const missing = [];

	// ExtraResources land unpacked (not asar'd) so the sidecar can be spawned
	// directly and the tray icon loaded from disk.
	const sidecarPath = path.join(resourcesDir, "omp-server", sidecarName(platform));
	try {
		await fs.access(sidecarPath);
	} catch {
		missing.push(`sidecar ${sidecarName(platform)} (expected at ${sidecarPath})`);
	}

	// A tree with a sidecar of the *other* architecture is just as broken as
	// one with none: the app would spawn a binary that cannot run. So the
	// foreign name must be absent, not merely the correct one present. The
	// build script removes both names before copying, so a clean build can
	// only ever produce one — this check catches a contaminated resources/
	// (e.g. from a cached build or a repackage on the other arch).
	const foreignName = platform === "win32" ? "omp" : "omp.exe";
	const foreignSidecarPath = path.join(resourcesDir, "omp-server", foreignName);
	let foreignPresent = false;
	try {
		await fs.access(foreignSidecarPath);
		foreignPresent = true;
	} catch {
		// Expected: only the platform-matched sidecar may be shipped.
	}
	if (foreignPresent) {
		missing.push(`foreign-architecture sidecar ${foreignName} (must not be at ${foreignSidecarPath})`);
	}

	const trayIconPath = path.join(resourcesDir, "tray-icon.png");
	try {
		await fs.access(trayIconPath);
	} catch {
		missing.push(`tray icon (expected at ${trayIconPath})`);
	}

	// The main and preload scripts are inside the asar, not unpacked, so their
	// presence is read from the archive listing rather than the filesystem. The
	// listing's separators and leading slash vary, so normalize to a plain
	// forward-slash, rootless path before comparing.
	const entries = asar
		.listPackage(asarPath)
		.map(entry => entry.replace(/\\/g, "/").replace(/^\//, ""));
	for (const required of REQUIRED_ASAR_ENTRIES) {
		if (!entries.some(entry => entry === required || entry.endsWith("/" + required))) {
			missing.push(`${required} inside app.asar`);
		}
	}

	if (missing.length > 0) {
		throw new Error(
			`Packaged app is incomplete; missing: ${missing.join("; ")}. ` +
				`Refusing to publish a build the first launch would fail on.`,
		);
	}
}

/**
 * The electron-builder hook. Resolves the resources directory and app.asar from
 * the builder's context (platform-dependent layout) and runs the check.
 */
async function afterPack(context) {
	const isMac = context.electronPlatformName === "darwin";
	// On macOS the packaged app is a bundle: context.appOutDir is the directory
	// *containing* `<productFilename>.app`, and the resources live inside it at
	// `Contents/Resources` — app-builder-lib's getMacOsResourcesDir layout, the
	// same one notarize.cjs resolves for its staple target. On win/linux the
	// resources directory sits directly under appOutDir.
	const resourcesDir = isMac
		? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
		: path.join(context.appOutDir, "resources");
	const asarPath = path.join(resourcesDir, "app.asar");
	await assertPackagedTree({ resourcesDir, asarPath, platform: context.electronPlatformName });
}

module.exports = afterPack;
module.exports.assertPackagedTree = assertPackagedTree;
module.exports.sidecarName = sidecarName;
module.exports.REQUIRED_ASAR_ENTRIES = REQUIRED_ASAR_ENTRIES;