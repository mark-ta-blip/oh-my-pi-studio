/**
 * Desktop runtime facts for the shell's "Desktop" setup section.
 *
 * The browser-served client never gets these: `window.ompStudio` is absent
 * there, the hook stays `null`, and the section simply does not render.
 *
 * Every value here is shell-owned (the app's own sidecar binary, the state
 * root the user chose) — the main process composes it from paths it already
 * owns, so nothing the data boundary protects crosses the channel.
 */

import { useEffect, useState } from "react";

export interface StudioDesktopRuntime {
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
	/** Where the omp-studio command shim lives, when installed. */
	shimDir: string | null;
	shimInstalled: boolean;
	/** The shim's target directory is on the default PATH without user configuration. */
	shimOnDefaultPath: boolean;
	/** A non-marker file occupies the shim name in the target dir. */
	shimConflict: boolean;
	/** A saved state root was unwritable and the launch fell back to the default. */
	storageRepaired: boolean;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * Validate the runtime payload before rendering it.
 *
 * The payload is trusted — it comes from the main process over the preload —
 * but a shell older or newer than this client may not send the same shape.
 * Refusing a partial payload degrades to "no Desktop section" rather than
 * rendering paths that are not real.
 */
export function parseStudioDesktopRuntime(value: unknown): StudioDesktopRuntime | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const state = value as Partial<StudioDesktopRuntime>;
	if (typeof state.packaged !== "boolean") return null;
	if (!isNonEmptyString(state.platform)) return null;
	if (!isNonEmptyString(state.sidecarPath)) return null;
	if (!isNonEmptyString(state.storageRoot)) return null;
	if (!isNonEmptyString(state.logPath)) return null;
	if (state.configRoot !== null && !isNonEmptyString(state.configRoot)) return null;
	if (state.shimDir !== null && !isNonEmptyString(state.shimDir)) return null;
	if (typeof state.shimInstalled !== "boolean") return null;
	if (typeof state.shimOnDefaultPath !== "boolean") return null;
	if (typeof state.shimConflict !== "boolean") return null;
	if (typeof state.storageRepaired !== "boolean") return null;
	return {
		packaged: state.packaged,
		platform: state.platform,
		sidecarPath: state.sidecarPath,
		storageRoot: state.storageRoot,
		logPath: state.logPath,
		configRoot: state.configRoot,
		shimDir: state.shimDir,
		shimInstalled: state.shimInstalled,
		shimOnDefaultPath: state.shimOnDefaultPath,
		shimConflict: state.shimConflict,
		storageRepaired: state.storageRepaired,
	};
}

/**
 * Read the shell's runtime facts once, or `null` outside the desktop shell.
 *
 * A one-shot read is enough: these values do not change while the app runs
 * (relocation and shim install both end in a relaunch, so the next load reads
 * fresh state).
 */
export function useStudioDesktopRuntime(): StudioDesktopRuntime | null {
	const [runtime, setRuntime] = useState<StudioDesktopRuntime | null>(null);
	useEffect(() => {
		const desktop = window.ompStudio;
		// A shell predating these channels leaves the section absent rather than
		// throwing on a missing method.
		if (!desktop || typeof desktop.getDesktopRuntime !== "function") return;
		let active = true;
		void desktop
			.getDesktopRuntime()
			.then(state => {
				if (active) setRuntime(parseStudioDesktopRuntime(state));
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);
	return runtime;
}
