import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { verifySidecarBinary } from "../src/main/sidecar-repair";

describe("sidecar-repair", () => {
	let root = "";

	beforeEach(async () => {
		root = path.join(os.tmpdir(), `sidecar-repair-${Math.floor(Math.random() * 1e9)}`);
		await fs.mkdir(root, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("reports a missing sidecar", async () => {
		const result = await verifySidecarBinary(root, "win32");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("missing");
	});

	it("accepts a present sidecar on Windows (no exec-bit check)", async () => {
		await fs.writeFile(path.join(root, "omp.exe"), "x", "utf8");
		const result = await verifySidecarBinary(root, "win32");
		expect(result).toEqual({ ok: true, path: path.join(root, "omp.exe") });
	});

	if (process.platform !== "win32") {
		it("accepts an executable sidecar off Windows", async () => {
			await fs.writeFile(path.join(root, "omp"), "x", "utf8");
			await fs.chmod(path.join(root, "omp"), 0o755);
			const result = await verifySidecarBinary(root, "linux");
			expect(result).toEqual({ ok: true, path: path.join(root, "omp") });
		});

		it("rejects a non-executable sidecar off Windows", async () => {
			await fs.writeFile(path.join(root, "omp"), "x", "utf8");
			await fs.chmod(path.join(root, "omp"), 0o644);
			const result = await verifySidecarBinary(root, "darwin");
			expect(result.ok).toBe(false);
			expect(result.reason).toBe("not-executable");
		});
	}
});
