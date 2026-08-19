import * as path from "node:path";

export interface DesktopPaths {
	packageRoot: string;
	userDataDir: string;
	windowStatePath: string;
	/** Append-only sidecar stderr log, kept so a failed startup can point at it. */
	sidecarLogPath: string;
	resourceDir: string;
	serverResourceDir: string;
}

export function createDesktopPaths(userDataDir: string, resourcesPath: string, packageRoot: string): DesktopPaths {
	return {
		packageRoot,
		userDataDir,
		windowStatePath: path.join(userDataDir, "window-state.json"),
		sidecarLogPath: path.join(userDataDir, "logs", "studio-server.log"),
		resourceDir: resourcesPath,
		serverResourceDir: path.join(resourcesPath, "omp-server"),
	};
}

/** Resolve the tray icon from the app bundle, or from source while developing. */
export function resolveTrayIconPath(paths: DesktopPaths, packaged: boolean): string {
	const directory = packaged ? paths.resourceDir : path.join(paths.packageRoot, "resources");
	return path.join(directory, "tray-icon.png");
}

export function resolveDevelopmentServerScript(packageRoot: string): string {
	return path.resolve(packageRoot, "..", "coding-agent", "src", "cli.ts");
}
