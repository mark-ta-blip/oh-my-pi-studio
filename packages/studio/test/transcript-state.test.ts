import { describe, expect, it } from "bun:test";
import { mergeStudioTranscriptSnapshot, upsertStudioTranscriptMessage } from "../src/client/transcript-state";
import type { StudioTranscriptMessage } from "../src/protocol";

function message(
	input: Partial<StudioTranscriptMessage> & Pick<StudioTranscriptMessage, "id" | "text">,
): StudioTranscriptMessage {
	return {
		createdAtMs: 1,
		role: "assistant",
		runId: "run_alpha",
		status: "streaming",
		studioSessionId: "sts_alpha",
		updatedAtMs: 1,
		...input,
	};
}

describe("Studio transcript state", () => {
	it("keeps a terminal assistant reply when a delayed streaming snapshot arrives", () => {
		const completed = message({ id: "msg_assistant", status: "completed", text: "Final reply.", updatedAtMs: 3 });
		const transcript = upsertStudioTranscriptMessage([], completed);
		const delayed = message({ id: completed.id, status: "streaming", text: "Final reply", updatedAtMs: 2 });

		expect(upsertStudioTranscriptMessage(transcript, delayed)).toEqual([completed]);
	});

	it("merges a REST snapshot without rolling back a newer WebSocket reply", () => {
		const currentAssistant = message({ id: "msg_assistant", text: "Current response.", updatedAtMs: 5 });
		const liveTranscript = [
			message({ id: "msg_user", role: "user", status: "completed", text: "Explain this.", updatedAtMs: 1 }),
			currentAssistant,
		];
		const snapshot = [
			message({ id: "msg_user", role: "user", status: "completed", text: "Explain this.", updatedAtMs: 1 }),
			message({ id: "msg_assistant", text: "Earlier response.", updatedAtMs: 4 }),
		];

		expect(mergeStudioTranscriptSnapshot(liveTranscript, snapshot)).toEqual(liveTranscript);
	});
});
