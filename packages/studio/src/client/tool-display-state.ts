import type { StudioToolDisplay } from "../protocol";

function compareToolDisplays(left: StudioToolDisplay, right: StudioToolDisplay): number {
	return left.updatedAtMs - right.updatedAtMs || left.id.localeCompare(right.id);
}

/** Merge a REST card snapshot without dropping a live WebSocket update. */
export function mergeStudioToolDisplaySnapshot(
	current: StudioToolDisplay[],
	snapshot: StudioToolDisplay[],
): StudioToolDisplay[] {
	const byId = new Map(current.map(display => [display.id, display]));
	for (const display of snapshot) {
		const existing = byId.get(display.id);
		if (!existing || compareToolDisplays(existing, display) <= 0) byId.set(display.id, display);
	}
	return [...byId.values()].sort((left, right) => compareToolDisplays(right, left));
}

/** Apply one live card update while keeping the inspector newest-first. */
export function upsertStudioToolDisplay(
	displays: StudioToolDisplay[],
	display: StudioToolDisplay,
): StudioToolDisplay[] {
	return mergeStudioToolDisplaySnapshot(displays, [display]);
}
