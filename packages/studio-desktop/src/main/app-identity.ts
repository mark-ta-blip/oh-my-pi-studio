/**
 * How the OS identifies this app, and how it starts it at login.
 *
 * Free of Electron imports so the platform branches are unit-testable.
 */

/**
 * Windows Application User Model ID.
 *
 * Notifications are attributed to an AUMID, not to a process: without this the
 * toast is labelled with the Electron executable and the user cannot mute or
 * find it under OMP Studio. It must equal `appId` in `electron-builder.yml`,
 * which is what the NSIS installer stamps onto the Start Menu shortcut — a
 * mismatch means Windows sees an unregistered app and drops the toast. A test
 * reads the two and compares them.
 */
export const APP_USER_MODEL_ID = "sh.omp.studio";

/**
 * The login item Electron can actually register.
 *
 * `openAtLogin` is a no-op on Linux, where autostart is a `.desktop` file in the
 * user's config directory rather than anything Electron writes. Offering the
 * checkbox there would be a control that silently does nothing.
 */
export function loginItemsAreSupported(platform: string): boolean {
	return platform === "darwin" || platform === "win32";
}

export interface LoginItemSettings {
	args?: string[];
	openAsHidden?: boolean;
	openAtLogin: boolean;
	path?: string;
}

/**
 * Resolve what to hand `app.setLoginItemSettings`.
 *
 * A login start goes to the tray rather than opening a window: the user asked for
 * OMP Studio to be running, not to have it take the foreground on every boot.
 * `--hidden` is the flag Phase 7 added for exactly this; macOS has no argument
 * support for login items and uses `openAsHidden` instead.
 */
export function resolveLoginItemSettings(platform: string, execPath: string, openAtLogin: boolean): LoginItemSettings {
	if (platform === "win32") return { openAtLogin, path: execPath, args: ["--hidden"] };
	if (platform === "darwin") return { openAtLogin, openAsHidden: true };
	return { openAtLogin };
}
