import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Managed `omp-studio` command shims.
 *
 * The shim makes the app's bundled runtime callable as `omp-studio` (open the
 * app) and `omp-studio cli ...` (run the bundled OMP CLI) without a global OMP
 * install and without editing any PATH entry: the target directory is chosen
 * from locations that are user-writable and, on Windows and Linux, already on
 * the default PATH. A shim is owned by its header marker (line 1 on Windows,
 * line 2 after the shebang on POSIX), and a file without it is the user's own
 * and is never clobbered.
 */
export const SHIM_MARKER = "OMP-STUDIO-SHIM";
export const SHIM_VERSION = 1;

export interface ShimBinCandidate {
	dir: string;
	/** The directory is on the default PATH without any user configuration. */
	onDefaultPath: boolean;
}

export interface ShimInstallStatus {
	dir: string | null;
	onDefaultPath: boolean;
	installed: boolean;
	/** A non-marker file already occupies the shim name in the target dir. */
	conflict: boolean;
}

/** The name the shim is installed as on this platform. */
export function shimFileName(platform: string): string {
	return platform === "win32" ? "omp-studio.cmd" : "omp-studio";
}

/** Windows env lookup is case-insensitive; the others are not. */
function findEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (env[name]) return env[name];
	const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
	return key ? env[key] : undefined;
}

/**
 * Ordered candidate directories for the shim, best first.
 *
 * Windows: the per-user WindowsApps dir ships on the default PATH and is
 * user-writable, so no PATH edit is ever needed; `%LOCALAPPDATA%\omp-studio\bin`
 * is the fallback when it cannot be used. macOS and Linux: `~/.local/bin`, on
 * the default PATH on Linux (XDG), not by default on macOS — the section then
 * shows a PATH hint. No PATH entry is modified in any case.
 */
export function resolveShimBinDir(platform: string, env: NodeJS.ProcessEnv): ShimBinCandidate[] {
	if (platform === "win32") {
		const candidates: ShimBinCandidate[] = [];
		const localAppData = findEnv(env, "LOCALAPPDATA");
		if (localAppData) {
			candidates.push({ dir: path.join(localAppData, "Microsoft", "WindowsApps"), onDefaultPath: true });
		}
		candidates.push({ dir: path.join(localAppData ?? os.homedir(), "omp-studio", "bin"), onDefaultPath: false });
		return candidates;
	}
	return [{ dir: path.join(os.homedir(), ".local", "bin"), onDefaultPath: platform === "linux" }];
}

/**
 * The shim body. The first line is the marker that identifies a shim as
 * OMP Studio's; the dispatch is: no args opens the app, `cli ...` runs the
 * bundled sidecar verbatim, everything else is an error.
 *
 * The Windows `cli` branch must not use `%*` to forward arguments: `%*`
 * always expands to the *original* argument list and is not affected by
 * `shift`, so it would pass the `cli` selector to the sidecar. Labels are
 * used instead of a parenthesized block so `%ERRORLEVEL%` is read after the
 * sidecar runs rather than at parse time.
 */
export function renderShim(platform: string, options: { appExecPath: string; sidecarPath: string }): string {
	const app = options.appExecPath;
	const sidecar = options.sidecarPath;
	if (platform === "win32") {
		return [
			`@REM ${SHIM_MARKER} v${SHIM_VERSION}`,
			"@echo off",
			"setlocal",
			'if "%~1"=="" (',
			`  start "" "${app}"`,
			"  exit /b 0",
			")",
			'if /i "%~1"=="-h" goto :help',
			'if /i "%~1"=="--help" goto :help',
			'if /i "%~1"=="cli" goto :cli',
			"echo Unknown command: %~1 >&2",
			"echo Run omp-studio --help for usage. >&2",
			"exit /b 2",
			":cli",
			"shift",
			// Rebuild the argument list from the shifted positional parameters,
			// so the `cli` token is dropped and the sidecar gets exactly the
			// remaining arguments, quoted.
			'set "OMP_STUDIO_CLI_ARGS="',
			":cli-args",
			// Terminator via `set` + `defined`, not `if "%1"==""`: an empty
			// *argument* reaches %1 as the two characters "" (a quoted value),
			// while an exhausted argument list is a zero-length %1. `set "T=%1"`
			// on a zero-length %1 clears T (undefined); on "" it leaves T
			// defined, so `if not defined T` distinguishes "no more arguments"
			// from "an empty argument" — and, unlike comparing %1 directly, it is
			// safe for quoted values, which would otherwise unbalance the if's
			// quotes.
			"set \"T=%1\"",
			"if not defined T goto :cli-run",
			// %1, not %~1: keep the user's quoting so a multi-word argument
			// survives the re-tokenization when the variable is expanded below.
			'set "OMP_STUDIO_CLI_ARGS=%OMP_STUDIO_CLI_ARGS% %1"',
			"shift",
			"goto :cli-args",
			":cli-run",
			`call "${sidecar}" %OMP_STUDIO_CLI_ARGS%`,
			"exit /b %ERRORLEVEL%",
			":help",
			"echo omp-studio - OMP Studio launcher",
			"echo.",
			"echo Usage:",
			"echo   omp-studio             Open the OMP Studio app",
			"echo   omp-studio -h|--help   Show this help",
			"echo   omp-studio cli ...     Run the bundled OMP CLI with the given arguments",
			"exit /b 0",
			"",
		].join("\r\n");
	}
	return [
		"#!/bin/sh",
		`# ${SHIM_MARKER} v${SHIM_VERSION}`,
		// Escaped so the shell parameter expansion is not mistaken for a template hole.
		`case "\${1-}" in`,
		'  "")',
		`    exec "${app}"`,
		"    ;;",
		"  -h|--help)",
		'    echo "omp-studio - OMP Studio launcher"',
		'    echo ""',
		'    echo "Usage:"',
		'    echo "  omp-studio             Open the OMP Studio app"',
		'    echo "  omp-studio -h|--help   Show this help"',
		'    echo "  omp-studio cli ...     Run the bundled OMP CLI with the given arguments"',
		"    exit 0",
		"    ;;",
		"  cli)",
		"    shift",
		`    exec "${sidecar}" "$@"`,
		"    ;;",
		"  *)",
		'    echo "Unknown command: $1" >&2',
		'    echo "Run omp-studio --help for usage." >&2',
		"    exit 2",
		"    ;;",
		"esac",
		"",
	].join("\n");
}

export type ShimWritePlan = "create" | "update" | "unchanged" | "conflict";

/**
 * Decide how a desired shim interacts with an existing file. Absent → create.
 * Present with the marker in its header → update in place (or unchanged when
 * already identical). Present without the marker → the user owns it: conflict,
 * never clobber.
 *
 * The marker is matched only in the first two lines, not the whole body: a
 * user file that merely mentions the marker in a comment lower down is still
 * the user's. Two lines cover both rendered shapes — the marker is line 1 on
 * Windows and line 2 (after the shebang) on POSIX.
 */
export function planShimWrite(existing: string | undefined, desired: string): ShimWritePlan {
	if (existing === undefined) return "create";
	const header = existing.split(/\r?\n/, 2);
	if (!header.some(line => line.includes(SHIM_MARKER))) return "conflict";
	if (existing === desired) return "unchanged";
	return "update";
}

/**
 * Install the shim into the first usable candidate directory. Best-effort by
 * contract: an unwritable dir or an existing user file is reported, never
 * thrown — the app's startup must not depend on a launcher command existing.
 */
export async function installCommandShims(options: {
	platform: string;
	env: NodeJS.ProcessEnv;
	appExecPath: string;
	sidecarPath: string;
}): Promise<ShimInstallStatus> {
	const desired = renderShim(options.platform, options);
	const name = shimFileName(options.platform);
	for (const candidate of resolveShimBinDir(options.platform, options.env)) {
		try {
			await fs.mkdir(candidate.dir, { recursive: true });
		} catch {
			continue;
		}
		const file = path.join(candidate.dir, name);
		let existing: string | undefined;
		try {
			existing = await fs.readFile(file, "utf8");
		} catch {
			existing = undefined;
		}
		const plan = planShimWrite(existing, desired);
		if (plan === "conflict")
			return { dir: candidate.dir, onDefaultPath: candidate.onDefaultPath, installed: false, conflict: true };
		if (plan === "unchanged")
			return { dir: candidate.dir, onDefaultPath: candidate.onDefaultPath, installed: true, conflict: false };
		try {
			await fs.writeFile(file, desired, "utf8");
			if (options.platform !== "win32") await fs.chmod(file, 0o755);
		} catch {
			continue;
		}
		return { dir: candidate.dir, onDefaultPath: candidate.onDefaultPath, installed: true, conflict: false };
	}
	return { dir: null, onDefaultPath: false, installed: false, conflict: false };
}
