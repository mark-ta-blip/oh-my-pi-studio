import { describe, expect, it } from "bun:test";
import type { StudioRun, StudioSession } from "../src/protocol";
import { reconcileStudioSession } from "../src/client/session-state";

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
});
