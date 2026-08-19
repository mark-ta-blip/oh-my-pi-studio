import { describe, expect, it } from "bun:test";
import { projectStudioActivityEvent } from "../src/core/activity-projection";
import type { StudioRpcAgentEvent } from "../src/core/rpc-supervisor";
import type { StudioActivitySubject } from "../src/protocol";

describe("Studio activity projection", () => {
	it("maps supported tool families to fixed browser-safe activity subjects", () => {
		const cases: Array<{ expected: StudioActivitySubject; toolName: string }> = [
			{ expected: "command", toolName: "bash" },
			{ expected: "command", toolName: "eval" },
			{ expected: "file_read", toolName: "read" },
			{ expected: "file_write", toolName: "write" },
			{ expected: "file_write", toolName: "edit" },
			{ expected: "file_write", toolName: "ast-edit" },
			{ expected: "file_search", toolName: "grep" },
			{ expected: "file_search", toolName: "glob" },
			{ expected: "file_search", toolName: "ast-grep" },
			{ expected: "web", toolName: "fetch" },
			{ expected: "web", toolName: "web_search" },
			{ expected: "web", toolName: "web-search" },
			{ expected: "web", toolName: "browser" },
			{ expected: "task", toolName: "task" },
			{ expected: "tool", toolName: "provider_private_tool" },
		];

		for (const { expected, toolName } of cases) {
			expect(projectStudioActivityEvent({ toolName, type: "tool_execution_start" })).toEqual({
				subject: expected,
				status: "running",
			});
		}
	});

	it("preserves lifecycle semantics while reducing native events to fixed presentation enums", () => {
		expect(projectStudioActivityEvent({ type: "agent_start" })).toEqual({ subject: "agent", status: "running" });
		expect(projectStudioActivityEvent({ isTerminal: false, type: "agent_end" })).toEqual({
			subject: "agent",
			status: "running",
		});
		expect(projectStudioActivityEvent({ type: "agent_end" })).toEqual({ subject: "agent", status: "completed" });
		expect(projectStudioActivityEvent({ isError: true, type: "agent_end" })).toEqual({
			subject: "agent",
			status: "failed",
		});
		expect(projectStudioActivityEvent({ type: "agent_end" }, { runCancelling: true })).toEqual({
			subject: "agent",
			status: "cancelled",
		});
		expect(projectStudioActivityEvent({ type: "auto_compaction_start" })).toEqual({
			subject: "context",
			status: "running",
		});
		expect(projectStudioActivityEvent({ type: "auto_compaction_end" })).toEqual({
			subject: "context",
			status: "completed",
		});
		expect(projectStudioActivityEvent({ type: "auto_retry_start" })).toEqual({ subject: "retry", status: "running" });
		expect(projectStudioActivityEvent({ type: "retry_fallback_succeeded" })).toEqual({
			subject: "retry",
			status: "completed",
		});
		expect(projectStudioActivityEvent({ type: "message_update" })).toBeUndefined();
	});

	it("omits a native tool name and raw payload from the activity representation", () => {
		const nativeEvent = {
			args: { command: "type C:\\private\\credentials.txt", path: "C:\\private\\credentials.txt" },
			result: { output: "secret output" },
			toolCallId: "call-private-tool",
			toolName: "vendor_private_tool",
			type: "tool_execution_end",
		} as unknown as StudioRpcAgentEvent;
		const projection = projectStudioActivityEvent(nativeEvent);

		expect(projection).toEqual({ subject: "tool", status: "completed" });
		expect(JSON.stringify(projection)).not.toContain("vendor_private_tool");
		expect(JSON.stringify(projection)).not.toContain("credentials.txt");
		expect(JSON.stringify(projection)).not.toContain("secret output");
	});
});
