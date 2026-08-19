import { describe, expect, it } from "bun:test";
import { mergeStudioRunHistorySnapshot, upsertStudioRunHistory } from "../src/client/history/run-history-state";
import type { StudioRun } from "../src/protocol";

function run(status: StudioRun["status"], startedAtMs: number, endedAtMs?: number): StudioRun {
	return {
		id: "run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		studioSessionId: "sts_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		status,
		startedAtMs,
		...(endedAtMs === undefined ? {} : { endedAtMs }),
	};
}

describe("Studio run history state", () => {
	it("does not replace a live terminal state with an older REST snapshot", () => {
		const terminal = run("interrupted", 10, 20);
		const stale = run("running", 10);

		expect(mergeStudioRunHistorySnapshot([terminal], [stale])).toEqual([terminal]);
	});

	it("accepts a newer terminal update and keeps history newest first", () => {
		const older = run("completed", 10, 20);
		const newer = { ...run("failed", 10, 30), id: "run_cccccccccccccccccccccccccccccccc" };

		const merged = upsertStudioRunHistory([older], newer);

		expect(merged).toEqual([newer, older]);
	});
});
