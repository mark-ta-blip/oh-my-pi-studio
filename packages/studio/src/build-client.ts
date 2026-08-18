import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

const CLIENT_SOURCE_DIR = path.join(import.meta.dir, "client");
export const STUDIO_CLIENT_DIST_DIR = path.join(import.meta.dir, "..", "dist", "client");

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#183f38">
  <title>OMP Studio</title>
  <link rel="stylesheet" href="/main.css">
</head>
<body>
  <div id="root"></div>
  <script src="/main.js" type="module"></script>
</body>
</html>`;

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}

	let latest = 0;
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			latest = Math.max(latest, await getLatestMtime(entryPath));
		} else if (entry.isFile()) {
			latest = Math.max(latest, (await fs.stat(entryPath)).mtimeMs);
		}
	}
	return latest;
}

async function getFileMtime(filePath: string): Promise<number> {
	try {
		return (await fs.stat(filePath)).mtimeMs;
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}
}

/** Build the browser shell used by source checkouts and embedded release assets. */
export async function buildStudioClient(): Promise<void> {
	await fs.rm(STUDIO_CLIENT_DIST_DIR, { recursive: true, force: true });
	const result = await Bun.build({
		entrypoints: [path.join(CLIENT_SOURCE_DIR, "main.tsx")],
		outdir: STUDIO_CLIENT_DIST_DIR,
		target: "browser",
		minify: true,
		naming: {
			entry: "[name].[ext]",
			chunk: "chunks/[name]-[hash].[ext]",
			asset: "assets/[name]-[hash].[ext]",
		},
	});
	if (!result.success) {
		throw new Error(`Studio client build failed:\n${result.logs.map(log => log.message).join("\n")}`);
	}
	await Bun.write(path.join(STUDIO_CLIENT_DIST_DIR, "index.html"), INDEX_HTML);
}

/** Build the source client only when its checked-in files are newer than the output. */
export async function ensureStudioClientBuild(): Promise<void> {
	const [sourceMtime, indexMtime, scriptMtime, styleMtime] = await Promise.all([
		getLatestMtime(CLIENT_SOURCE_DIR),
		getFileMtime(path.join(STUDIO_CLIENT_DIST_DIR, "index.html")),
		getFileMtime(path.join(STUDIO_CLIENT_DIST_DIR, "main.js")),
		getFileMtime(path.join(STUDIO_CLIENT_DIST_DIR, "main.css")),
	]);
	if (Math.min(indexMtime, scriptMtime, styleMtime) >= sourceMtime && sourceMtime > 0) return;
	await buildStudioClient();
}
