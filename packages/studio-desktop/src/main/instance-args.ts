/** Command-line switches the desktop shell understands. */
export interface StudioDesktopArgs {
	/** Start to the tray without showing a window. Honoured only when a tray exists. */
	hidden: boolean;
	/** Stop an already-running instance instead of opening one. */
	quitExisting: boolean;
	/** Run the packaged sidecar contract check and exit without a window. */
	smokeTest: boolean;
}

export function parseStudioDesktopArgs(argv: readonly string[]): StudioDesktopArgs {
	return {
		hidden: argv.includes("--hidden"),
		quitExisting: argv.includes("--quit"),
		smokeTest: argv.includes("--smoke-test"),
	};
}

/**
 * Whether a second instance asked the running one to quit.
 *
 * Electron delivers both the new process's argv and an arbitrary JSON payload to
 * `second-instance`. The payload arrives from another process, so it is validated
 * rather than trusted: only the exact `{ quit: true }` shape counts.
 */
export function isStudioQuitRequest(argv: readonly string[], additionalData: unknown): boolean {
	if (argv.includes("--quit")) return true;
	if (!additionalData || typeof additionalData !== "object" || Array.isArray(additionalData)) return false;
	return (additionalData as Record<string, unknown>).quit === true;
}
