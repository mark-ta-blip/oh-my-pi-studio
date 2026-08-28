import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { hasNotaryCredentials, notarizeApp } from "../scripts/notarize.cjs";

/**
 * The `xcrun` invocations a notarization makes, in order. Recorded by the
 * injected runner so the credential handling is asserted without needing a
 * macOS `xcrun` on the test machine.
 */
function fakeRunner(calls: string[][]) {
	return async (command: string, args: string[]): Promise<string> => {
		calls.push([command, ...args]);
		return "";
	};
}

function envWithKey(key: string) {
	return {
		APPLE_API_KEY_ID: "KEYID123",
		APPLE_API_ISSUER_ID: "issuer-uuid",
		APPLE_API_KEY: key,
	};
}

describe("notarize", () => {
	it("reports credentials present only when all three are set", () => {
		const full = envWithKey(Buffer.from("p8-bytes").toString("base64"));
		expect(hasNotaryCredentials(full)).toBe(true);
		expect(hasNotaryCredentials({ ...full, APPLE_API_KEY: "" })).toBe(false);
		expect(hasNotaryCredentials({ ...full, APPLE_API_KEY_ID: "" })).toBe(false);
		expect(hasNotaryCredentials({ ...full, APPLE_API_ISSUER_ID: "" })).toBe(false);
	});

	it("decodes the base64 key to a temp file, submits with --issuer, and removes it", async () => {
		const calls: string[][] = [];
		const keyBytes = "p8-private-key-bytes";
		await notarizeApp("some.app", {
			env: envWithKey(Buffer.from(keyBytes).toString("base64")),
			run: fakeRunner(calls),
		});
		expect(calls).toHaveLength(2);
		const [submit, staple] = calls;
		expect(submit[0]).toBe("xcrun");
		expect(submit).toContain("notarytool");
		expect(submit).toContain("submit");
		// The notary flag is `--issuer` (a bare `--key-issuer` is not a
		// notarytool option), and the id/issuer pair is passed through.
		expect(submit).toContain("--issuer");
		expect(submit).toContain("issuer-uuid");
		expect(submit).toContain("--key-id");
		expect(submit).toContain("KEYID123");
		// The decoded key is passed as a file path (notarytool takes a path,
		// and the secret holds base64), and that file is gone after the run:
		// the private key must not outlive the notarization.
		const keyIndex = submit.indexOf("--key");
		expect(keyIndex).toBeGreaterThan(-1);
		const keyPath = submit[keyIndex + 1];
		expect(keyPath).toContain("key.p8");
		await expect(fs.stat(keyPath)).rejects.toThrow();
		expect(staple).toEqual(["xcrun", "stapler", "staple", "some.app"]);
	});
});