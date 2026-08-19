import type { StudioActivityEntry } from "../protocol";

/** Merge a durable activity snapshot without discarding WebSocket entries received during the request. */
export function mergeStudioActivitySnapshot(
	current: StudioActivityEntry[],
	snapshot: StudioActivityEntry[],
): StudioActivityEntry[] {
	const snapshotIds = new Set(snapshot.map(entry => entry.id));
	return [...current.filter(entry => !snapshotIds.has(entry.id)), ...snapshot];
}

/** Apply one browser-safe WebSocket entry while keeping the inspector in reverse chronological order. */
export function upsertStudioActivityEntry(
	entries: StudioActivityEntry[],
	entry: StudioActivityEntry,
): StudioActivityEntry[] {
	return [entry, ...entries.filter(current => current.id !== entry.id)];
}
