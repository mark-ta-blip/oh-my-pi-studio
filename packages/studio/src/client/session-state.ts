import type { StudioRun, StudioSession } from "../protocol";

export function isTerminalRunStatus(status: StudioRun["status"]): boolean {
	return ["completed", "cancelled", "interrupted", "failed"].includes(status);
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
	if (!expectedRun) return { run: undefined, session };
	if (snapshotRun && responseRun && snapshotRun.id !== responseRun.id) {
		return { run: snapshotRun, session };
	}
	const run = observedRun?.id === expectedRun.id ? observedRun : expectedRun;
	return { run, session: applyRunStateToSession(session, run) };
}
