import type { StudioRun, StudioSession } from "../protocol";

export function isActiveRunStatus(status: StudioRun["status"]): boolean {
	return status === "starting" || status === "running" || status === "cancelling";
}

export function isActiveRun(run: StudioRun | undefined): run is StudioRun {
	return run !== undefined && !isTerminalRunStatus(run.status);
}

export function isTerminalRunStatus(status: StudioRun["status"]): boolean {
	return status === "completed" || status === "cancelled" || status === "interrupted" || status === "failed";
}

export function applyRunStateToSession(session: StudioSession, run: StudioRun): StudioSession {
	if (isTerminalRunStatus(run.status)) {
		return {
			...session,
			activeRun: undefined,
			status: "ready",
		};
	}
	return { ...session, activeRun: run, status: "running" };
}

/** Merge a REST session snapshot without rolling back a newer local run event. */
export function mergeStudioSessionSnapshot(current: StudioSession, snapshot: StudioSession): StudioSession {
	const currentRun = current.activeRun;
	if (!currentRun || !isActiveRun(currentRun)) return snapshot;

	const snapshotRun = snapshot.activeRun;
	if (!snapshotRun) {
		// A running status without an active run is a torn REST read. Keep the
		// local active run until a terminal snapshot is observed.
		if (snapshot.status === "running" || snapshot.updatedAtMs <= currentRun.startedAtMs) {
			return applyRunStateToSession(snapshot, currentRun);
		}
		return snapshot;
	}

	if (snapshotRun.id === currentRun.id) return snapshot;
	const snapshotRunTime = snapshotRun.endedAtMs ?? snapshotRun.startedAtMs;
	return currentRun.startedAtMs > snapshotRunTime ? applyRunStateToSession(snapshot, currentRun) : snapshot;
}

export interface ReconciledStudioSession {
	run: StudioRun | undefined;
	session: StudioSession;
}

/** Reconcile an HTTP session snapshot with the newest event only when both describe the same run. */
export function reconcileStudioSession(
	session: StudioSession,
	responseRun: StudioRun | undefined,
	observedRun: StudioRun | undefined,
): ReconciledStudioSession {
	const snapshotRun = session.activeRun;
	const expectedRun = responseRun ?? snapshotRun;
	if (!expectedRun) {
		if (observedRun && isActiveRun(observedRun)) {
			if (session.status === "running" || session.updatedAtMs <= observedRun.startedAtMs) {
				return { run: observedRun, session: applyRunStateToSession(session, observedRun) };
			}
		}
		return { run: undefined, session };
	}
	if (snapshotRun && responseRun && snapshotRun.id !== responseRun.id) {
		return { run: snapshotRun, session };
	}
	const run = observedRun?.id === expectedRun.id ? observedRun : expectedRun;
	return { run, session: applyRunStateToSession(session, run) };
}
