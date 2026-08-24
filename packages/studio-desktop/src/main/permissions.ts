/**
 * What the shell grants when a renderer asks the OS for something.
 *
 * Electron's default is to allow most permission requests, which means a page
 * inside the shell could reach the microphone, the clipboard read API, or
 * geolocation with no code here having decided that. This module is the decision,
 * and it is deny-by-default.
 */

/**
 * Permissions a phase has deliberately enabled.
 *
 * Empty, because nothing in Studio needs one yet. Phase 17 (voice) is what adds
 * `media`, and only for the window kinds it names. Adding an entry here is the
 * whole grant, so it should not happen without the phase that justifies it.
 */
const ALLOWED_PERMISSIONS = new Set<string>();

export interface StudioPermissionRequest {
	/** True only for a renderer this shell created and still owns. */
	fromStudioRenderer: boolean;
	permission: string;
}

/**
 * Decide a permission request or check.
 *
 * Both halves matter. An unknown renderer is refused whatever it asks for — that
 * is the case an embedded browser or a stray `WebContentsView` would fall into.
 * A known renderer is still refused anything not on the allowlist, so a new
 * Chromium permission that did not exist when this was written arrives denied
 * rather than allowed.
 */
export function isStudioPermissionAllowed(request: StudioPermissionRequest): boolean {
	if (!request.fromStudioRenderer) return false;
	return ALLOWED_PERMISSIONS.has(request.permission);
}
