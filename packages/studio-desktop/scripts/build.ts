import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const distDir = path.join(packageRoot, "dist");

async function build(entrypoint: string, outdir: string, naming: string, format: "esm" | "cjs"): Promise<void> {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outdir,
		naming,
		target: "node",
		format,
		external: ["electron"],
		minify: false,
	});
	if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
}

await fs.rm(distDir, { recursive: true, force: true });
await build(path.join(packageRoot, "src", "main", "index.ts"), path.join(distDir, "main"), "[name].js", "esm");
await build(path.join(packageRoot, "src", "preload", "index.ts"), path.join(distDir, "preload"), "[name].cjs", "cjs");
