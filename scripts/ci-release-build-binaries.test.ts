import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";

const repoRoot = path.join(import.meta.dir, "..");

/** Client archives every release path regenerates, and that must stay empty in the tree. */
const embeddedClientPlaceholders = [
	"packages/stats/src/embedded-client.generated.txt",
	"packages/studio/src/embedded-client.generated.txt",
];

describe("Windows release binary target", () => {
	it("builds the generic Windows release asset with the baseline runtime", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("uses the baseline runtime for local Windows cross-build aliases", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
	});
});

describe("embedded client bundles", () => {
	it("generates and resets every client archive around the binary builds", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		// A release that skips one of these embeds whatever the tree happens to
		// hold, which is how a stale Studio bundle shipped before.
		for (const script of ["gen:stats", "gen:studio"]) {
			expect(output).toContain(`DRY RUN bun run ${script}\n`);
			expect(output).toContain(`DRY RUN bun run ${script}:reset\n`);
		}
	});

	it.each(embeddedClientPlaceholders)("keeps %s empty in the checked-in tree", async placeholder => {
		// A populated placeholder outranks the freshly built client in prebuilt
		// releases, so committing one silently ships stale UI.
		expect(await fs.readFile(path.join(repoRoot, placeholder), "utf8")).toBe("");
	});
});
