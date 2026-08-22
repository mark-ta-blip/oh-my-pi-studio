import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const distDir = path.join(packageRoot, "dist");
const splashSourceDir = path.join(packageRoot, "src", "splash");
const splashDistDir = path.join(distDir, "splash");

async function build(
	entrypoint: string,
	outdir: string,
	naming: string,
	format: "esm" | "cjs",
	target: "node" | "browser" = "node",
): Promise<void> {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outdir,
		naming,
		target,
		format,
		external: ["electron"],
		minify: false,
	});
	if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
}

await fs.rm(distDir, { recursive: true, force: true });
await build(path.join(packageRoot, "src", "main", "index.ts"), path.join(distDir, "main"), "[name].js", "esm");
await build(path.join(packageRoot, "src", "preload", "index.ts"), path.join(distDir, "preload"), "[name].cjs", "cjs");
// The splash is a real document loaded from disk, not an injected data URL, so its
// markup and stylesheet ship verbatim beside a browser-targeted script.
await build(path.join(splashSourceDir, "splash.ts"), splashDistDir, "[name].js", "esm", "browser");
await fs.mkdir(splashDistDir, { recursive: true });
for (const asset of ["index.html", "splash.css"]) {
	await fs.copyFile(path.join(splashSourceDir, asset), path.join(splashDistDir, asset));
}
