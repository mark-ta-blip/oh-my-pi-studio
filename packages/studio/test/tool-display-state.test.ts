import { describe, expect, it } from "bun:test";
import { mergeStudioPlanSummary } from "../src/client/plan-state";
import { mergeStudioToolDisplaySnapshot, upsertStudioToolDisplay } from "../src/client/tool-display-state";
import type { StudioPlanSummary, StudioToolDisplay } from "../src/protocol";

function toolDisplay(id: string, status: StudioToolDisplay["status"], updatedAtMs: number): StudioToolDisplay {
	return {
		id,
		kind: "file_write",
		runId: "run_tool_display",
		startedAtMs: 10,
		status,
		studioSessionId: "sts_tool_display",
		updatedAtMs,
	};
}

function plan(updatedAtMs: number, completedTaskCount: number): StudioPlanSummary {
	return {
		abandonedTaskCount: 0,
		blockedTaskCount: 0,
		completedTaskCount,
		inProgressTaskCount: 1,
		pendingTaskCount: 2,
		runId: "run_plan",
		studioSessionId: "sts_plan",
		totalTaskCount: completedTaskCount + 3,
		updatedAtMs,
	};
}

describe("Studio tool-card and plan state", () => {
	it("retains a newer live tool outcome when an older REST snapshot arrives", () => {
		const older = toolDisplay("tcd_older", "completed", 100);
		const live = toolDisplay("tcd_live", "failed", 200);
		const staleLive = toolDisplay("tcd_live", "running", 150);

		expect(mergeStudioToolDisplaySnapshot([live, older], [staleLive])).toEqual([live, older]);
		expect(upsertStudioToolDisplay([older], live)).toEqual([live, older]);
	});

	it("keeps the newest aggregate when plan hydration races an event", () => {
		const live = plan(200, 4);
		const snapshot = plan(150, 3);

		expect(mergeStudioPlanSummary(live, snapshot)).toEqual(live);
		expect(mergeStudioPlanSummary(snapshot, live)).toEqual(live);
	});
});
