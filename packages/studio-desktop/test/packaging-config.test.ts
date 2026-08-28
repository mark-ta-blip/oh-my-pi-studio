import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const BUILDER_CONFIG = path.join(import.meta.dir, "..", "electron-builder.yml");
const ENTITLEMENTS = path.join(import.meta.dir, "..", "resources", "entitlements.mac.plist");

async function readConfig(): Promise<string> {
	return Bun.file(BUILDER_CONFIG).text();
}

/** The value of a top-level `key:` line, e.g. `afterPack: ./scripts/after-pack.cjs`. */
function topLevel(config: string, key: string): string | undefined {
	return new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m").exec(config)?.[1];
}

/** The value of an indented `key:` line inside a section, e.g. `  hardenedRuntime: true`. */
function sectionValue(config: string, section: string, key: string): string | undefined {
	const sectionBody = new RegExp(`^${section}:\\n((?:[ \\t]+.*\\n?)+)`, "m").exec(config);
	if (!sectionBody) return undefined;
	return new RegExp(`^[ \\t]+${key}:\\s*(\\S+)\\s*$`, "m").exec(sectionBody[1])?.[1];
}

/** The `target:` list under a section, as an array of values. */
function sectionTargets(config: string, section: string): string[] {
	const sectionBody = new RegExp(`^${section}:\\n((?:[ \\t]+.*\\n?)+)`, "m").exec(config);
	if (!sectionBody) return [];
	const targetBody = /[ \t]+target:\n((?:[ \t]+-\s*\S+\s*\n)+)/m.exec(sectionBody[1]);
	if (!targetBody) return [];
	return [...targetBody[1].matchAll(/-\s*(\S+)/g)].map(match => match[1]);
}

describe("electron-builder config", () => {
	test("runs the afterPack self-check and the notarize hook", async () => {
		const config = await readConfig();
		expect(topLevel(config, "afterPack")).toBe("./scripts/after-pack.cjs");
		expect(topLevel(config, "afterSign")).toBe("./scripts/notarize.cjs");
	});

	test("enables hardened runtime and the entitlements on macOS", async () => {
		const config = await readConfig();
		expect(sectionValue(config, "mac", "hardenedRuntime")).toBe("true");
		expect(sectionValue(config, "mac", "gatekeeperAssess")).toBe("false");
		expect(sectionValue(config, "mac", "entitlements")).toBe("resources/entitlements.mac.plist");
		expect(sectionValue(config, "mac", "entitlementsInherit")).toBe("resources/entitlements.mac.plist");
	});

	test("ships all five targets the release matrix builds", async () => {
		const config = await readConfig();
		expect(sectionTargets(config, "win")).toEqual(["nsis"]);
		expect(sectionTargets(config, "mac")).toEqual(["dmg", "zip"]);
		expect(sectionTargets(config, "linux")).toEqual(["AppImage", "deb"]);
	});
});

describe("entitlements.mac.plist", () => {
	test("grants the three hardened-runtime keys the Bun sidecar needs", async () => {
		const plist = await Bun.file(ENTITLEMENTS).text();
		for (const key of [
			"com.apple.security.cs.allow-jit",
			"com.apple.security.cs.allow-unsigned-executable-memory",
			"com.apple.security.cs.disable-library-validation",
		]) {
			expect(plist).toContain(`<key>${key}</key>`);
			expect(plist).toContain("<true/>");
		}
	});
});
