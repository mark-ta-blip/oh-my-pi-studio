import * as path from "node:path";

export interface DesktopPaths {
	packageRoot: string;
	userDataDir: string;
	windowStatePath: string;
	serverResourceDir: string;
}

export function createDesktopPaths(userDataDir: string, resourcesPath: string, packageRoot: string): DesktopPaths {
	return {
		packageRoot,
		userDataDir,
		windowStatePath: path.join(userDataDir, "window-state.json"),
		serverResourceDir: path.join(resourcesPath, "omp-server"),
	};
}

export function resolveDevelopmentServerScript(packageRoot: string): string {
	return path.resolve(packageRoot, "..", "coding-agent", "src", "cli.ts");
}
