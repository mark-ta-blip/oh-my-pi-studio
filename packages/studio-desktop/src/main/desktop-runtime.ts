import * as path from "node:path";
import type { ShimInstallStatus } from "./command-shim";
import type { DesktopPaths } from "./paths";

/**
 * The runtime facts the Desktop section shows. Every value here is shell-owned:
 * the app's own sidecar binary under its resources dir, and the state root the
 * user themselves chose. None of these is a session path, a provider secret, a
 * tool payload, or an arbitrary workspace path, so the whole struct is safe to
 * hand to the renderer.
 */
export interface DesktopRuntimeInfo {
	packaged: boolean;
	platform: string;
	/** The bundled sidecar binary the shell spawns. */
	sidecarPath: string;
	/** The effective state root for this launch (window state, sidecar log). */
	storageRoot: string;
	/** Where the sidecar's stderr is appended. */
	logPath: string;
	/** The OMP config root the sidecar runs under, or null for the default ~/.omp. */
	configRoot: string | null;
	/** Where the omp-studio command shim is installed, when one is installed. */
	shimDir: string | null;
	shimInstalled: boolean;
	/** The shim's target directory is on the default PATH without user configuration. */
	shimOnDefaultPath: boolean;
	/** A non-marker file already occupies the shim name in the target dir. */
	shimConflict: boolean;
	/** A saved state root was unwritable and the launch fell back to the default. */
	storageRepaired: boolean;
}

/**
 * Assemble the runtime info. Kept pure so the per-platform sidecar path and the
 * null-coercion of the optional fields are testable without Electron.
 */
export function resolveDesktopRuntimeInfo(
	paths: DesktopPaths,
	packaged: boolean,
	platform: string,
	shim: ShimInstallStatus,
	storageRepaired: boolean,
): DesktopRuntimeInfo {
	return {
		packaged,
		platform,
		sidecarPath: path.join(paths.serverResourceDir, platform === "win32" ? "omp.exe" : "omp"),
		storageRoot: paths.stateRoot,
		logPath: paths.sidecarLogPath,
		configRoot: paths.configRoot ?? null,
		shimDir: shim.installed ? shim.dir : null,
		shimInstalled: shim.installed,
		shimOnDefaultPath: shim.installed ? shim.onDefaultPath : false,
		shimConflict: shim.conflict,
		storageRepaired,
	};
}
