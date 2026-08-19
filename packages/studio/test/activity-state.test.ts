import { describe, expect, it } from "bun:test";
import { mergeStudioActivitySnapshot, upsertStudioActivityEntry } from "../src/client/activity-state";
import type { StudioActivityEntry } from "../src/protocol";

function activity(id: string, occurredAtMs: number): StudioActivityEntry {
	return {
		id,
		occurredAtMs,
		runId: "run_activity",
		status: "completed",
		studioSessionId: "sts_activity",
		subject: "tool",
	};
}

describe("Studio activity state", () => {
	it("keeps a newer live entry while restoring the stable SQLite snapshot order", () => {
		const older = activity("act_older", 100);
		const newer = activity("act_newer", 100);
		const live = activity("act_live", 101);

		expect(mergeStudioActivitySnapshot([live, older], [newer, older])).toEqual([live, newer, older]);
		expect(upsertStudioActivityEntry([newer, older], live)).toEqual([live, newer, older]);
	});
});
