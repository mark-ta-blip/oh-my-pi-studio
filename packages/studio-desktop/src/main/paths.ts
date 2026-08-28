import * as path from "node:path";
import { desktopStorageSettingsFileName } from "./desktop-storage";

export interface DesktopPaths {
	packageRoot: string;
	/** Effective state dir for this launch: the user-chosen root when set and writable, else the default. */
	userDataDir: string;
	/** The platform-default userData dir, where the storage settings file itself lives. */
	originalUserDataDir: string;
	/** Where the chosen state root is remembered; it must not live inside the movable root. */
	storageSettingsPath: string;
	/** The state root the user sees: window state and sidecar log live here. */
	stateRoot: string;
	windowStatePath: string;
	/** Append-only sidecar stderr log, kept so a failed startup can point at it. */
	sidecarLogPath: string;
	/**
	 * The OMP config root handed to the sidecar via OMP_CONFIG_ROOT. `undefined`
	 * means the default `~/.omp`: without an explicit relocation the sidecar
	 * keeps the user's existing config, sessions, and providers.
	 */
	configRoot: string | undefined;
	resourceDir: string;
	serverResourceDir: string;
}

export function createDesktopPaths(
	effectiveUserDataDir: string,
	originalUserDataDir: string,
	resourcesPath: string,
	packageRoot: string,
	configRoot: string | undefined,
): DesktopPaths {
	return {
		packageRoot,
		userDataDir: effectiveUserDataDir,
		originalUserDataDir,
		storageSettingsPath: path.join(originalUserDataDir, desktopStorageSettingsFileName()),
		stateRoot: effectiveUserDataDir,
		windowStatePath: path.join(effectiveUserDataDir, "window-state.json"),
		sidecarLogPath: path.join(effectiveUserDataDir, "logs", "studio-server.log"),
		configRoot,
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
