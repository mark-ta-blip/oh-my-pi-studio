import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Persisted window geometry. Position is optional so Electron can center a fresh window. */
export interface WindowState {
	width: number;
	height: number;
	x?: number;
	y?: number;
}

/** A screen rectangle to validate against — in practice an Electron display's `workArea`. */
export interface DisplayArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 840 };
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;

/** Enough of the window must land on a display for the user to grab and move it. */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 60;

function isValidDimension(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

function isValidOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

/** Parse persisted geometry, falling back to the default for anything unusable. */
export function parseWindowState(raw: string): WindowState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_WINDOW_STATE;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_WINDOW_STATE;
	const value = parsed as Partial<WindowState>;
	if (!isValidDimension(value.width, MIN_WINDOW_WIDTH) || !isValidDimension(value.height, MIN_WINDOW_HEIGHT)) {
		return DEFAULT_WINDOW_STATE;
	}
	return {
		width: value.width,
		height: value.height,
		...(isValidOffset(value.x) ? { x: value.x } : {}),
		...(isValidOffset(value.y) ? { y: value.y } : {}),
	};
}

export async function readWindowState(filePath: string): Promise<WindowState> {
	try {
		return parseWindowState(await fs.readFile(filePath, "utf8"));
	} catch {
		return DEFAULT_WINDOW_STATE;
	}
}

export async function writeWindowState(filePath: string, state: WindowState): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

function intersection(a: DisplayArea, b: DisplayArea): DisplayArea | undefined {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (right <= x || bottom <= y) return undefined;
	return { x, y, width: right - x, height: bottom - y };
}

/**
 * Fit restored geometry to the displays actually attached now.
 *
 * A window saved on a monitor that is no longer present would otherwise be
 * restored offscreen: visible to Electron, unreachable for the user, and — with
 * close mapped to hide — impossible to recover from. Unreachable positions are
 * dropped so Electron centers the window instead, and the size is capped to the
 * display it lands on.
 */
export function clampWindowStateToDisplays(state: WindowState, displays: readonly DisplayArea[]): WindowState {
	if (displays.length === 0) return state;
	const { x, y } = state;
	const host =
		x === undefined || y === undefined
			? undefined
			: displays.find(display => {
					const visible = intersection({ x, y, width: state.width, height: state.height }, display);
					return (
						visible !== undefined && visible.width >= MIN_VISIBLE_WIDTH && visible.height >= MIN_VISIBLE_HEIGHT
					);
				});
	const bounds = host ?? displays[0];
	const size = {
		width: Math.max(MIN_WINDOW_WIDTH, Math.min(state.width, bounds.width)),
		height: Math.max(MIN_WINDOW_HEIGHT, Math.min(state.height, bounds.height)),
	};
	return host === undefined ? size : { ...size, x, y };
}
