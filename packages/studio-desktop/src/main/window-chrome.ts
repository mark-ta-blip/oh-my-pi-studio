/**
 * Which window chrome the OS draws and which the Studio client draws.
 *
 * Kept free of Electron imports so both the resolver and the IPC argument guard
 * are unit-testable without launching a window, in the pattern of
 * `external-url.ts` and `window-state.ts`.
 */

/** The three window operations the renderer is allowed to request. */
export type WindowControlAction = "close" | "minimize" | "toggle-maximize";

const WINDOW_CONTROL_ACTIONS = new Set<string>([
	"close",
	"minimize",
	"toggle-maximize",
] satisfies WindowControlAction[]);

/**
 * Narrow an IPC argument to a control action.
 *
 * The renderer supplies this string, so an unknown value has to be rejected
 * rather than defaulted: defaulting would let a typo close the window.
 */
export function parseWindowControlAction(value: unknown): WindowControlAction | undefined {
	if (typeof value !== "string" || !WINDOW_CONTROL_ACTIONS.has(value)) return undefined;
	return value as WindowControlAction;
}

/** The platform names the chrome layout distinguishes; anything else is `other`. */
export type WindowChromePlatform = "darwin" | "linux" | "other" | "win32";

export function resolveWindowChromePlatform(platform: string): WindowChromePlatform {
	switch (platform) {
		case "darwin":
			return "darwin";
		case "linux":
			return "linux";
		case "win32":
			return "win32";
		default:
			return "other";
	}
}

/**
 * The `BrowserWindow` options that remove the OS title bar.
 *
 * Only the fields that differ by platform are here; the caller spreads them over
 * the rest of its options so an unset field stays at Electron's default rather
 * than being pinned to it here.
 */
export interface WindowChromeOptions {
	frame?: boolean;
	titleBarOverlay?: WindowControlsOverlay | true;
	titleBarStyle?: "hidden" | "hiddenInset";
}

export interface WindowControlsOverlay {
	color: string;
	height: number;
	symbolColor: string;
}

/**
 * Matches `.studio-desktop-shell .studio-titlebar` in the client stylesheet.
 *
 * The overlay is drawn by the OS over the client area, so a height that
 * disagrees with the rendered title bar puts the caption buttons outside it.
 */
export const TITLEBAR_HEIGHT = 56;

/** The title bar's own background and icon colours, so the overlay matches it. */
export const TITLEBAR_OVERLAY_COLOR = "#17292d";
export const TITLEBAR_OVERLAY_SYMBOL_COLOR = "#dcebe6";

/**
 * Resolve the chrome for a platform.
 *
 * Windows and macOS keep their native caption buttons — `titleBarStyle` hides the
 * bar but leaves the controls, which is what preserves Windows 11 snap layouts on
 * maximize hover and the macOS traffic lights. `titleBarOverlay` is what exposes
 * the `titlebar-area-*` CSS environment variables the client uses to keep its own
 * controls out from under them.
 *
 * Linux has no equivalent guarantee across desktop environments, so the window is
 * plainly frameless there and the client draws the controls itself.
 */
export function resolveWindowChromeOptions(platform: string): WindowChromeOptions {
	switch (resolveWindowChromePlatform(platform)) {
		case "win32":
			return {
				titleBarStyle: "hidden",
				titleBarOverlay: {
					color: TITLEBAR_OVERLAY_COLOR,
					height: TITLEBAR_HEIGHT,
					symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
				},
			};
		case "darwin":
			// macOS accepts only a boolean here; the traffic lights keep system colours.
			return { titleBarStyle: "hiddenInset", titleBarOverlay: true };
		default:
			return { frame: false };
	}
}

/** True when no OS caption buttons exist, so the client has to render its own. */
export function windowControlsAreDrawnInWindow(platform: string): boolean {
	return resolveWindowChromeOptions(platform).titleBarOverlay === undefined;
}

/**
 * What the renderer is told about the window it is drawing chrome for.
 *
 * Every field is either already observable from the renderer or is chrome layout
 * state it needs to render correctly, so this adds nothing to what the client may
 * hold under the presentation boundary.
 */
export interface WindowChromeState {
	controlsInWindow: boolean;
	fullScreen: boolean;
	maximized: boolean;
	platform: WindowChromePlatform;
}
