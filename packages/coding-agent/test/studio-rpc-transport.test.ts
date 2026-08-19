import { describe, expect, it } from "bun:test";
import {
	createStudioApprovalRequest,
	extractStudioAssistantTranscriptText,
	extractStudioPlanSummary,
	redactStudioAgentEvent,
	studioAssistantMessageKeys,
} from "../src/cli/studio-rpc-transport";
import { shouldRestoreDisplaySecrets, studioRpcChildEnvironment } from "../src/secrets/studio-secret-redaction";

describe("Studio RPC transport redaction", () => {
	it("replaces sensitive tool arguments with a digest before an approval reaches Studio", () => {
		const rawArguments = {
			command: "cat C:\\private\\credentials.txt",
			path: "C:\\private\\credentials.txt",
			replacement: "replace this secret value",
		};
		const approval = createStudioApprovalRequest(
			{
				reason: "configured policy for C:\\private\\credentials.txt requires confirmation",
				requestId: "native-approval-1",
				toolCallId: "tool-call-1",
				toolName: "write",
			},
			rawArguments,
		);

		expect(approval).toMatchObject({
			argumentsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			reason: "OMP requires confirmation for this tool.",
			requestId: "native-approval-1",
			toolCallId: "tool-call-1",
			toolName: "write",
		});
		expect(JSON.stringify(approval)).not.toContain(rawArguments.path);
		expect(JSON.stringify(approval)).not.toContain(rawArguments.replacement);
		expect(JSON.stringify(approval)).not.toContain("credentials.txt requires confirmation");
		expect(
			createStudioApprovalRequest(
				{ requestId: "native-approval-2", toolCallId: "tool-call-2", toolName: "write" },
				{ ...rawArguments, path: "C:\\private\\different.txt" },
			).argumentsDigest,
		).not.toBe(approval.argumentsDigest);
	});

	it("removes native tool output and arguments while retaining server-side tool classification", () => {
		const nativeEvent = {
			args: { path: "C:\\private\\credentials.txt", replacement: "replace this secret value" },
			isError: true,
			result: { content: [{ text: "C:\\private\\credentials.txt", type: "text" }] },
			toolCallId: "tool-call-1",
			toolName: "write",
			type: "tool_execution_end",
		};
		const event = redactStudioAgentEvent(nativeEvent);

		expect(event).toEqual({
			isError: true,
			toolCallId: "tool-call-1",
			toolName: "write",
			type: "tool_execution_end",
		});
		expect(JSON.stringify(event)).not.toContain("credentials.txt");
		expect(JSON.stringify(event)).not.toContain("replace this secret value");
	});

	it("extracts only text blocks from assistant message snapshots", () => {
		const transcript = extractStudioAssistantTranscriptText({
			assistantMessageEvent: { delta: "Visible answer", type: "text_delta" },
			message: {
				content: [
					{ thinking: "internal reasoning", type: "thinking" },
					{ arguments: { path: "C:\\private\\credentials.txt" }, name: "read", type: "toolCall" },
					{ text: "Visible answer", type: "text" },
				],
				providerPayload: { items: [{ secret: "replace this secret value" }] },
				role: "assistant",
			},
			type: "message_update",
		});

		expect(transcript).toBe("Visible answer");
		expect(
			extractStudioAssistantTranscriptText({
				message: {
					content: [{ text: "C:\\private\\credentials.txt", type: "text" }],
					role: "toolResult",
				},
				type: "message_end",
			}),
		).toBeUndefined();
	});

	it("reduces completed todo results to bounded counters without task text or tool output", () => {
		const summary = extractStudioPlanSummary({
			isError: false,
			result: {
				details: {
					phases: [
						{
							tasks: [
								{ status: "pending", text: "read C:\\private\\credentials.txt" },
								{ status: "in_progress", text: "replace this secret value" },
								{ output: "private result", status: "completed" },
								{ reason: "blocked by secret", status: "blocked" },
								{ status: "abandoned", text: "discard private attempt" },
								{ status: "unknown", text: "must not count" },
							],
						},
					],
				},
			},
			toolName: "todo",
			type: "tool_execution_end",
		});

		expect(summary).toEqual({
			abandonedTaskCount: 1,
			blockedTaskCount: 1,
			completedTaskCount: 1,
			inProgressTaskCount: 1,
			pendingTaskCount: 1,
			totalTaskCount: 5,
		});
		expect(JSON.stringify(summary)).not.toContain("credentials.txt");
		expect(JSON.stringify(summary)).not.toContain("replace this secret value");
		expect(JSON.stringify(summary)).not.toContain("private result");
	});

	it("caps todo inspection before a malformed tool result can monopolize the transport", () => {
		const summary = extractStudioPlanSummary({
			result: {
				phases: [{ tasks: Array.from({ length: 4_097 }, () => ({ status: "completed" })) }],
			},
			toolName: "todo",
			type: "tool_execution_end",
		});

		expect(summary).toMatchObject({ completedTaskCount: 4_096, totalTaskCount: 4_096 });
	});

	it("keeps a streaming assistant reply attached to its timestamp when the final response adds an ID", () => {
		expect(studioAssistantMessageKeys({ responseId: "response-final", timestamp: 1_700_000_000_000 })).toEqual([
			"timestamp:1700000000000",
			"response:response-final",
		]);
		expect(studioAssistantMessageKeys({ responseId: "response-only" })).toEqual(["response:response-only"]);
	});

	it("forces Studio RPC children to retain secret placeholders in display events", () => {
		const environment = studioRpcChildEnvironment({
			OMP_STUDIO_REDACT_DISPLAY_SECRETS: "0",
			PATH: "C:\\bin",
		});

		expect(environment).toEqual({
			OMP_STUDIO_REDACT_DISPLAY_SECRETS: "1",
			PATH: "C:\\bin",
		});
		expect(shouldRestoreDisplaySecrets(environment)).toBe(false);
		expect(shouldRestoreDisplaySecrets({})).toBe(true);
	});
});
