/**
 * Every user-visible string the main process owns: dialogs, tray, splash, and
 * startup failures. The renderer has its own copy for the Studio client; this
 * table is only for text the shell produces before or outside that client.
 *
 * `en` is the base locale. A later phase can add locales beside it; until then
 * `t` exists so no phase reintroduces inline literals.
 */
const EN = {
	"failure.copy": "Copy details",
	"failure.logs": "Open log folder",
	"failure.retry": "Try again",
	"failure.serverOutput": "Recent OMP Studio server output",
	"failure.serverLog": "Full server log",
	"failure.title": "OMP Studio could not start",
	"ipc.senderRejected": "OMP Studio desktop controls are only available to the OMP Studio window.",
	"ipc.urlRequired": "OMP Studio can only open a URL.",
	"ipc.windowActionRequired": "OMP Studio received an unknown window control action.",
	"ipc.windowNotReady": "OMP Studio window is not ready.",
	"preload.detail": "Restart OMP Studio. If the issue persists, reinstall the app.",
	"preload.message": "OMP Studio could not initialize its desktop integration.",
	"preload.title": "OMP Studio desktop controls are unavailable",
	"stage.loading": "Opening the workbench",
	"stage.locating": "Locating the OMP runtime",
	"stage.starting": "Starting the local OMP server",
	"startup.externalOnlyHttp": "OMP Studio can only open HTTP or HTTPS links outside the app.",
	"tray.hide": "Hide OMP Studio",
	"tray.logs": "Open log folder",
	"tray.quit": "Quit",
	"tray.show": "Show OMP Studio",
	"workspace.pickerTitle": "Select workspace",
} as const;

export type StudioDesktopStringKey = keyof typeof EN;

/** Resolve a main-process string. Unknown keys are a type error, not a runtime fallback. */
export function t(key: StudioDesktopStringKey): string {
	return EN[key];
}
