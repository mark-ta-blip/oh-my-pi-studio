import type { StudioRun } from "../../protocol";

function isTerminalRun(run: StudioRun): boolean {
	return ["completed", "cancelled", "interrupted", "failed"].includes(run.status);
}

function shouldKeepCurrent(current: StudioRun, snapshot: StudioRun): boolean {
	if (isTerminalRun(current) && !isTerminalRun(snapshot)) return true;
	if (!isTerminalRun(current) || !isTerminalRun(snapshot)) return false;
	return (current.endedAtMs ?? current.startedAtMs) > (snapshot.endedAtMs ?? snapshot.startedAtMs);
}

/** Merge a REST run snapshot without rolling a newer terminal WebSocket state backward. */
export function mergeStudioRunHistorySnapshot(current: StudioRun[], snapshot: StudioRun[]): StudioRun[] {
	const byId = new Map(current.map(run => [run.id, run]));
	for (const incoming of snapshot) {
		const existing = byId.get(incoming.id);
		if (!existing || !shouldKeepCurrent(existing, incoming)) byId.set(incoming.id, incoming);
	}
	return [...byId.values()].sort(
		(left, right) =>
			(right.endedAtMs ?? right.startedAtMs) - (left.endedAtMs ?? left.startedAtMs) ||
			right.id.localeCompare(left.id),
	);
}

/** Apply one live run state while preserving the same terminal-state guarantee as REST hydration. */
export function upsertStudioRunHistory(runs: StudioRun[], run: StudioRun): StudioRun[] {
	return mergeStudioRunHistorySnapshot(runs, [run]);
}
