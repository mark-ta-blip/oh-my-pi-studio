import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The user-chosen state root for OMP Studio's desktop state.
 *
 * The chosen root is remembered in a settings file that lives in the
 * *platform-default* userData dir, not inside the movable root itself — the
 * pointer cannot live inside the thing it points at. Relocation moves the
 * desktop-owned state (window geometry, sidecar log) and, on a fresh root,
 * the OMP config the sidecar runs under; the config root itself is derived
 * from the effective root by the caller.
 */
export interface DesktopStorageSettings {
	stateRoot: string;
}

const STORAGE_SETTINGS_FILE_NAME = "desktop-settings.json";
const STATE_ROOT_MAX_LENGTH = 4096;
/** The probe file a write check leaves behind long enough to prove the dir is writable. */
const WRITE_PROBE_FILE_NAME = ".omp-studio-write-probe";

/** The desktop-owned entries relocation migrates. Anything else is left behind. */
const MIGRATED_ENTRIES = ["window-state.json", "logs"] as const;

/**
 * Whether a path is absolute on the given platform. An explicit platform keeps
 * the branch testable off the host OS: the shipped Windows build validates
 * drive-letter roots, and no CI runner is Windows.
 */
function isAbsoluteStorageRoot(candidate: string, platform: string): boolean {
	if (platform === "win32") return /^[a-zA-Z]:[\\/]/.test(candidate);
	return candidate.startsWith("/");
}

/**
 * Parse persisted storage settings, rejecting anything that would not be a safe
 * state root: bad JSON, a non-string, an empty or overlong path, an embedded
 * NUL, or a path that is not absolute. `null` means "use the default".
 */
export function parseDesktopStorageSettings(
	raw: string,
	platform: string = process.platform,
): DesktopStorageSettings | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const value = parsed as { stateRoot?: unknown };
	if (typeof value.stateRoot !== "string") return null;
	const stateRoot = value.stateRoot.trim();
	if (!stateRoot || stateRoot.length > STATE_ROOT_MAX_LENGTH) return null;
	if (stateRoot.includes("\0")) return null;
	if (!isAbsoluteStorageRoot(stateRoot, platform)) return null;
	return { stateRoot };
}

export function desktopStorageSettingsFileName(): string {
	return STORAGE_SETTINGS_FILE_NAME;
}

export async function readDesktopStorageSettings(settingsPath: string): Promise<DesktopStorageSettings | null> {
	try {
		return parseDesktopStorageSettings(await fs.readFile(settingsPath, "utf8"));
	} catch {
		return null;
	}
}

export async function writeDesktopStorageSettings(
	settingsPath: string,
	settings: DesktopStorageSettings,
): Promise<void> {
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

/** Remove the settings file so the next launch uses the default state dir. Missing is fine. */
export async function clearDesktopStorageSettings(settingsPath: string): Promise<void> {
	try {
		await fs.unlink(settingsPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
}

/**
 * Whether `dir` can actually hold state: it can be created and a probe file can
 * be written to and removed from it. Any failure — a path that is a file, a
 * read-only volume, a missing drive — returns `false` without throwing.
 */
export async function probeWritableDir(dir: string): Promise<boolean> {
	const probe = path.join(dir, WRITE_PROBE_FILE_NAME);
	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(probe, "omp-studio", "utf8");
		await fs.unlink(probe);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a state root already holds desktop state. A fresh relocation migrates
 * the default's window geometry and log tree once; a root that already has them
 * (a moved-back or repeated move) is left exactly as it is.
 */
export async function hasMigratedState(stateRoot: string): Promise<boolean> {
	try {
		return (await fs.stat(path.join(stateRoot, "window-state.json"))).isFile();
	} catch {
		return false;
	}
}

/**
 * Copy a file or directory into `target` without clobbering anything already
 * there: an existing file or directory at any level is kept, so state the user
 * already has always wins over the source. A missing source entry is skipped
 * silently.
 */
async function copyWithoutClobber(source: string, target: string): Promise<void> {
	try {
		await fs.stat(source);
	} catch {
		return;
	}
	const stat = await fs.stat(source);
	if (stat.isDirectory()) {
		await fs.mkdir(target, { recursive: true });
		for (const name of await fs.readdir(source)) {
			const from = path.join(source, name);
			const to = path.join(target, name);
			try {
				await fs.stat(to);
			} catch {
				// No target entry at this level: the source wins.
				await copyWithoutClobber(from, to);
			}
		}
		return;
	}
	try {
		await fs.stat(target);
	} catch {
		// No target file: copy the source as-is.
		await fs.copyFile(source, target);
	}
}

/**
 * Best-effort copy of the desktop-owned state from one root to another.
 *
 * Never throws: a missing entry means the source is fresh, and an existing
 * entry in the target is newer state that must not be clobbered.
 */
export async function migrateDesktopState(fromDir: string, toDir: string): Promise<void> {
	try {
		await fs.mkdir(toDir, { recursive: true });
	} catch {
		return;
	}
	for (const entry of MIGRATED_ENTRIES) {
		try {
			await copyWithoutClobber(path.join(fromDir, entry), path.join(toDir, entry));
		} catch {
			// Missing or unreadable — a fresh state root is a valid outcome.
		}
	}
}

/**
 * The OMP config root the sidecar runs under when nothing is overridden: the
 * same resolution the sidecar itself uses (an absolute OMP_CONFIG_ROOT, or
 * PI_CONFIG_DIR, or .omp under home), so a relocation migrates exactly the
 * root the sidecar currently uses.
 */
export function defaultConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OMP_CONFIG_ROOT?.trim();
	if (override && path.isAbsolute(override)) return path.resolve(override);
	return path.join(os.homedir(), env.PI_CONFIG_DIR || ".omp");
}

/**
 * Whether a relocated root already carries OMP config: the directory exists
 * non-empty. A root the user moved back to already has its own config, and a
 * half-migrated root is left alone rather than re-copied.
 */
export async function hasMigratedConfig(configDir: string): Promise<boolean> {
	try {
		return (await fs.readdir(configDir)).length > 0;
	} catch {
		return false;
	}
}

/**
 * Best-effort copy of the OMP config a relocation moves with its state root.
 *
 * Never throws: a missing config dir means the user never had one, and an
 * existing entry in the target always wins. The target is the `<root>/omp`
 * directory the sidecar will be handed as OMP_CONFIG_ROOT.
 */
export async function migrateConfigRoot(sourceConfigRoot: string, stateRoot: string): Promise<void> {
	try {
		await copyWithoutClobber(sourceConfigRoot, path.join(stateRoot, "omp"));
	} catch {
		// A fresh state root is a valid outcome even without an OMP config.
	}
}

export interface EffectiveDesktopStorage {
	userDataDir: string;
	/** A saved root existed but could not be used for this launch. */
	repaired: boolean;
}

/**
 * Choose the state root for this launch. A saved root is used only when it is
 * actually writable; otherwise the app falls back to the default for this
 * launch (it never fails to start over storage) and reports the repair so the
 * Desktop section can offer to fix it.
 */
export function resolveEffectiveStorage(
	defaultUserDataDir: string,
	settings: DesktopStorageSettings | null,
	writable: boolean,
): EffectiveDesktopStorage {
	if (settings && writable) return { userDataDir: settings.stateRoot, repaired: false };
	return { userDataDir: defaultUserDataDir, repaired: settings !== null };
}
