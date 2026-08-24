/**
 * Window chrome state for the desktop shell's frameless window.
 *
 * The browser-served client never gets this: `window.ompStudio` is absent there,
 * the hook stays `null`, and the title bar renders exactly as it always has.
 */

import { useEffect, useState } from "react";

export type StudioWindowControlAction = "close" | "minimize" | "toggle-maximize";

export type StudioWindowChromePlatform = "darwin" | "linux" | "other" | "win32";

export interface StudioWindowChrome {
	/** True when the OS draws no caption buttons, so the client must render them. */
	controlsInWindow: boolean;
	fullScreen: boolean;
	maximized: boolean;
	platform: StudioWindowChromePlatform;
}

const PLATFORMS = new Set<string>(["darwin", "linux", "other", "win32"]);

/**
 * Validate the shell's window state before rendering chrome from it.
 *
 * The payload is trusted — it comes from the main process over the preload — but a
 * shell older or newer than this client may not send the same shape. Refusing a
 * partial payload degrades to the browser title bar, which is always usable,
 * instead of rendering controls that are wired to nothing.
 */
export function parseStudioWindowChrome(value: unknown): StudioWindowChrome | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const state = value as Partial<StudioWindowChrome>;
	if (typeof state.controlsInWindow !== "boolean") return null;
	if (typeof state.fullScreen !== "boolean" || typeof state.maximized !== "boolean") return null;
	if (typeof state.platform !== "string" || !PLATFORMS.has(state.platform)) return null;
	return {
		controlsInWindow: state.controlsInWindow,
		fullScreen: state.fullScreen,
		maximized: state.maximized,
		platform: state.platform,
	};
}

/** Ask the shell to minimize, toggle maximize, or close. A no-op in a browser. */
export function requestStudioWindowControl(action: StudioWindowControlAction): void {
	const desktop = window.ompStudio;
	if (!desktop || typeof desktop.windowControl !== "function") return;
	void desktop.windowControl(action).catch(() => undefined);
}

/**
 * Track the shell window's chrome state, or `null` outside the desktop shell.
 *
 * Both halves matter: the initial read covers a client that loaded into an already
 * maximized window, and the subscription covers every later change the client did
 * not cause — a snap gesture, a double-click on the drag region, an OS shortcut.
 */
export function useStudioWindowChrome(): StudioWindowChrome | null {
	const [chrome, setChrome] = useState<StudioWindowChrome | null>(null);
	useEffect(() => {
		const desktop = window.ompStudio;
		// A shell predating these channels leaves the client on the browser title
		// bar rather than throwing on a missing method.
		if (!desktop || typeof desktop.getWindowState !== "function") return;
		let active = true;
		void desktop
			.getWindowState()
			.then(state => {
				if (active) setChrome(parseStudioWindowChrome(state));
			})
			.catch(() => undefined);
		if (typeof desktop.onWindowStateChange !== "function") {
			return () => {
				active = false;
			};
		}
		const unsubscribe = desktop.onWindowStateChange(state => {
			const parsed = parseStudioWindowChrome(state);
			if (parsed) setChrome(parsed);
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);
	return chrome;
}
