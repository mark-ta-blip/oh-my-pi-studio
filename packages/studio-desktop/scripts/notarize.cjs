/**
 * electron-builder `afterSign` hook: notarize the macOS app bundle.
 *
 * Notarization needs Apple's notary service credentials, which are secrets and
 * only exist in CI. When they are absent the hook is a no-op and the build
 * stays unsigned-but-validated, which is the same contract the Windows build has
 * always had. This mirrors the sign-skip contract already in the release
 * workflow rather than inventing a new one.
 *
 * `afterSign` runs after the bundle is signed but before the dmg is assembled,
 * so the submission input is the `.app` itself — the one artifact that is
 * guaranteed to exist at this point. Stapling the receipt into the `.app` is
 * enough for Gatekeeper to verify the bundle offline.
 */
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The notary service reads these from the environment; all three are required.
 *
 * `APPLE_API_KEY` follows the repository's Apple-credential convention (the same
 * one `scripts/ci-macos-sign.sh` decodes): it is the *base64* of the
 * App Store Connect `.p8` private key, not the key itself. `notarytool --key`
 * takes a file path, so the decoded key is written to a temp file first.
 */
const APPLE_CREDENTIAL_ENV = ["APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY"];

/** True when every notary credential the service needs is present. */
function hasNotaryCredentials(env = process.env) {
	return APPLE_CREDENTIAL_ENV.every(name => Boolean(env[name]));
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
			else resolve(stdout);
		});
	});
}

/**
 * Submit the app bundle to Apple's notary service, wait for the verdict, then
 * staple the receipt into the `.app`.
 *
 * `runner` is the process-spawning function, injectable so the credential
 * handling is testable without an `xcrun` on the machine; it defaults to the
 * real `run` (which shells out to `xcrun`).
 */
async function notarizeApp(appPath, { env = process.env, run: runner = run } = {}) {
	// `notarytool --key` expects a path to the .p8 key file. The repository
	// stores the key base64-encoded in the secret (ci-macos-sign.sh decodes it
	// the same way), so write the decoded key to a 0600 temp file, submit, then
	// remove it — the private key never lives in a path that outlives the run.
	const apiKeyPath = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "omp-studio-notary-")),
		"key.p8",
	);
	try {
		fs.writeFileSync(apiKeyPath, Buffer.from(env.APPLE_API_KEY, "base64"), { mode: 0o600 });
		await runner("xcrun", [
			"notarytool",
			"submit",
			appPath,
			"--key",
			apiKeyPath,
			"--key-id",
			env.APPLE_API_KEY_ID,
			"--issuer",
			env.APPLE_API_ISSUER_ID,
			"--wait",
		]);
		await runner("xcrun", ["stapler", "staple", appPath]);
	} finally {
		fs.rmSync(path.dirname(apiKeyPath), { recursive: true, force: true });
	}
}

/**
 * The electron-builder hook. Only runs on a macOS build, and only when the
 * notary credentials are present; otherwise it reports the skip and returns.
 */
async function afterSign(context) {
	if (context.electronPlatformName !== "darwin") return;
	if (!hasNotaryCredentials(process.env)) {
		console.log("APPLE_API_KEY_ID/ISSUER_ID/KEY not set; skipping notarization (unsigned build).");
		return;
	}
	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productName}.app`);
	await notarizeApp(appPath);
	console.log(`Notarized and stapled ${path.basename(appPath)}`);
}

module.exports = afterSign;
module.exports.hasNotaryCredentials = hasNotaryCredentials;
module.exports.notarizeApp = notarizeApp;