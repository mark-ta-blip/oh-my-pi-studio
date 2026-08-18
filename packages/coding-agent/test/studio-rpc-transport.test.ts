import { describe, expect, it } from "bun:test";
import { createStudioApprovalRequest, redactStudioAgentEvent } from "../src/cli/studio-rpc-transport";

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

	it("removes native tool output and arguments from browser agent events", () => {
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
});
