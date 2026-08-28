/**
 * Every user-visible string the main process owns: dialogs, tray, splash, and
 * startup failures. The renderer has its own copy for the Studio client; this
 * table is only for text the shell produces before or outside that client.
 *
 * `en` is the base locale. A later phase can add locales beside it; until then
 * `t` exists so no phase reintroduces inline literals.
 */
const EN = {
	"desktop.checksumNote": "Verify your installer against the SHA256SUMS.txt published on the release page.",
	"desktop.releasesLink": "View releases",
	"desktop.section": "Desktop",
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
	"menu.copyLink": "Copy link address",
	"preload.detail": "Restart OMP Studio. If the issue persists, reinstall the app.",
	"preload.message": "OMP Studio could not initialize its desktop integration.",
	"preload.title": "OMP Studio desktop controls are unavailable",
	"repair.ok": "The bundled OMP runtime is in place and executable.",
	"repair.reinstall": "The bundled OMP runtime is missing or not executable. Reinstall OMP Studio to restore it.",
	"shim.conflict":
		"An omp-studio command already exists in that directory and is not owned by OMP Studio, so it was left untouched.",
	"shim.pathHint":
		"The omp-studio command was installed, but its directory is not on your PATH. Add {dir} to your PATH to use it.",
	"shim.ready": "The omp-studio command is installed and on your PATH.",
	"stage.loading": "Opening the workbench",
	"stage.locating": "Locating the OMP runtime",
	"stage.starting": "Starting the local OMP server",
	"startup.externalOnlyHttp": "OMP Studio can only open HTTP or HTTPS links outside the app.",
	"storage.pickerTitle": "Choose the OMP Studio state folder",
	"storage.repaired":
		"The saved state folder is unavailable, so OMP Studio is running from its default location this time.",
	"storage.unwritable": "The chosen folder could not be written to. Pick a location you have permission to write to.",
	"tray.hide": "Hide OMP Studio",
	"tray.logs": "Open log folder",
	"tray.openAtLogin": "Open at login",
	"tray.quit": "Quit",
	"tray.show": "Show OMP Studio",
	"workspace.pickerTitle": "Select workspace",
} as const;

export type StudioDesktopStringKey = keyof typeof EN;

/** Resolve a main-process string. Unknown keys are a type error, not a runtime fallback. */
export function t(key: StudioDesktopStringKey): string {
	return EN[key];
}
