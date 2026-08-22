/**
 * Minimal shape of the objects the guard compares, so the check is testable
 * without constructing an Electron window.
 */
export interface StudioIpcTarget {
	isDestroyed(): boolean;
	webContents: unknown;
}

/**
 * Whether an IPC call came from a window this shell created and still owns.
 *
 * Every privileged channel is reachable from any renderer in the process, so the
 * sender has to be checked rather than assumed. A destroyed window is treated as
 * no window at all: its `webContents` may still compare equal while the window
 * behind it is gone.
 */
export function isStudioIpcSender(sender: unknown, target: StudioIpcTarget | null | undefined): boolean {
	if (!target || target.isDestroyed()) return false;
	return sender === target.webContents;
}
