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
	const resourcesDir = path.join(packageRoot, "resources");
	const targetName = targetPlatform === "win32" ? "omp.exe" : "omp";
	const destination = path.join(resourcesDir, targetName);
	// A source that is the destination itself (a dev run pointing the env var at
	// the already-staged binary) must not be removed by the cleanup below: the
	// copy would then fail with ENOENT from a path the script just deleted.
	if (path.resolve(source) !== destination) {
		await fs.mkdir(resourcesDir, { recursive: true });
		// Drop both sidecar names first so a repackage on the other architecture
		// cannot leave a stale binary beside the new one — the build would then
		// ship a resources/ with two sidecars, and the app would spawn whichever
		// name it reads first.
		await fs.rm(path.join(resourcesDir, "omp"), { force: true });
		await fs.rm(path.join(resourcesDir, "omp.exe"), { force: true });
		await fs.copyFile(source, destination);
	} else {
		// The sidecar is already in place under the right name; a foreign-arch
		// binary beside it is still a contamination the build must not ship.
		await fs.rm(path.join(resourcesDir, targetName === "omp.exe" ? "omp" : "omp.exe"), { force: true });
	}
	if (process.platform !== "win32") await fs.chmod(destination, 0o755);
	console.log(`Copied OMP Studio sidecar to ${destination}`);
}
