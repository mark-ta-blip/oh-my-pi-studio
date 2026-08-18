import { describe, expect, it } from "bun:test";
import {
	isActiveRun,
	isActiveRunStatus,
	mergeStudioSessionSnapshot,
	reconcileStudioSession,
} from "../src/client/session-state";
import type { StudioRun, StudioSession } from "../src/protocol";

const session: StudioSession = {
	createdAtMs: 1,
	id: "sts_1234567890abcdef1234567890abcdef",
	profile: "default",
	status: "running",
	updatedAtMs: 2,
	workspaceId: "wsp_1234567890abcdef1234567890abcdef",
};

function run(id: string, status: StudioRun["status"]): StudioRun {
	return {
		id,
		startedAtMs: 2,
		status,
		studioSessionId: session.id,
	};
}

describe("Studio prompt response session state", () => {
	it("only treats non-terminal run states as active", () => {
		expect(isActiveRunStatus("starting")).toBe(true);
		expect(isActiveRunStatus("running")).toBe(true);
		expect(isActiveRunStatus("cancelling")).toBe(true);
		expect(isActiveRunStatus("completed")).toBe(false);
		expect(isActiveRunStatus("cancelled")).toBe(false);
		expect(isActiveRunStatus("interrupted")).toBe(false);
		expect(isActiveRunStatus("failed")).toBe(false);
		expect(isActiveRun({ ...run("run_terminal", "completed"), endedAtMs: 3 })).toBe(false);
	});

	it("keeps a terminal WebSocket update for the submitted run while ignoring an earlier run", () => {
		const firstResponseRun = run("run_11111111111111111111111111111111", "running");
		const firstTerminalRun = { ...firstResponseRun, endedAtMs: 3, status: "completed" as const };
		const secondRun = run("run_22222222222222222222222222222222", "running");
		const firstResponseSession: StudioSession = { ...session, activeRun: firstResponseRun };
		const secondResponseSession: StudioSession = { ...session, activeRun: secondRun };

		expect(reconcileStudioSession(firstResponseSession, firstResponseRun, firstTerminalRun).session).toEqual({
			...firstResponseSession,
			activeRun: undefined,
			status: "ready",
		});
		expect(reconcileStudioSession(secondResponseSession, secondRun, firstTerminalRun).session).toEqual(
			secondResponseSession,
		);
		expect(reconcileStudioSession(secondResponseSession, undefined, firstTerminalRun)).toEqual({
			run: secondRun,
			session: secondResponseSession,
		});
	});

	it("clears a stale local active run when a newer ready snapshot arrives", () => {
		const activeRun = { ...run("run_active", "running"), startedAtMs: 10 };
		const current = { ...session, status: "running" as const, updatedAtMs: 10, activeRun };
		const readySnapshot = { ...session, status: "ready" as const, updatedAtMs: 20 };

		expect(mergeStudioSessionSnapshot(current, readySnapshot)).toEqual(readySnapshot);
	});

	it("keeps a newer local active run when a REST snapshot started before it", () => {
		const activeRun = { ...run("run_new", "running"), startedAtMs: 20 };
		const current = { ...session, status: "running" as const, updatedAtMs: 20, activeRun };
		const olderSnapshot = { ...session, status: "ready" as const, updatedAtMs: 19 };

		expect(mergeStudioSessionSnapshot(current, olderSnapshot)).toMatchObject({
			status: "running",
			activeRun,
		});
	});
});
