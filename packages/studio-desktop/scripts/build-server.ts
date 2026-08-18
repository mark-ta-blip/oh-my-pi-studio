import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const resourcesDir = path.join(packageRoot, "resources");
const source = process.env.OMP_STUDIO_OMP_EXECUTABLE;
const targetPlatform =
	Bun.argv.find(value => value.startsWith("--platform="))?.slice("--platform=".length) ?? process.platform;

if (!source) {
	throw new Error(
		"Set OMP_STUDIO_OMP_EXECUTABLE to the platform-matched OMP binary before packaging OMP Studio Desktop.",
	);
} else {
	const destination = path.join(resourcesDir, targetPlatform === "win32" ? "omp.exe" : "omp");
	await fs.mkdir(resourcesDir, { recursive: true });
	await fs.copyFile(source, destination);
	if (process.platform !== "win32") await fs.chmod(destination, 0o755);
	console.log(`Copied OMP Studio sidecar to ${destination}`);
}
