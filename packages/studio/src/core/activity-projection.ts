import type { StudioActivityStatus, StudioActivitySubject, StudioToolDisplayKind } from "../protocol";

const TOOL_SUBJECTS: Readonly<Record<string, StudioActivitySubject>> = {
	"ast-edit": "file_write",
	"ast-grep": "file_search",
	bash: "command",
	browser: "web",
	edit: "file_write",
	eval: "command",
	fetch: "web",
	glob: "file_search",
	grep: "file_search",
	read: "file_read",
	task: "task",
	web_search: "web",
	"web-search": "web",
	write: "file_write",
};

export interface StudioActivityProjection {
	status: StudioActivityStatus;
	subject: StudioActivitySubject;
}

export interface StudioActivityProjectionOptions {
	runCancelling?: boolean;
}

/** Redacted source metadata available only while the Studio supervisor is projecting an event. */
interface StudioActivitySourceEvent {
	type: string;
	isError?: boolean;
	isTerminal?: boolean;
	toolName?: string;
}

function projectToolSubject(toolName: string | undefined): StudioActivitySubject {
	return toolName === undefined ? "tool" : (TOOL_SUBJECTS[toolName] ?? "tool");
}

/** Reduce a native tool name to the fixed card kind safe for browser presentation. */
export function projectStudioToolDisplayKind(toolName: string | undefined): StudioToolDisplayKind {
	const subject = projectToolSubject(toolName);
	return subject === "command" ||
		subject === "file_read" ||
		subject === "file_write" ||
		subject === "file_search" ||
		subject === "web" ||
		subject === "task"
		? subject
		: "tool";
}

function projectCompletionStatus(event: StudioActivitySourceEvent): StudioActivityStatus {
	return event.isError ? "failed" : "completed";
}

/**
 * Converts a redacted native event into the fixed activity vocabulary that is
 * safe to persist and return to the Studio browser.
 */
export function projectStudioActivityEvent(
	event: StudioActivitySourceEvent,
	options: StudioActivityProjectionOptions = {},
): StudioActivityProjection | undefined {
	switch (event.type) {
		case "agent_start":
			return { subject: "agent", status: "running" };
		case "agent_end":
			if (event.isTerminal === false) return { subject: "agent", status: "running" };
			return { subject: "agent", status: options.runCancelling ? "cancelled" : projectCompletionStatus(event) };
		case "tool_execution_start":
			return { subject: projectToolSubject(event.toolName), status: "running" };
		case "tool_execution_end":
			return { subject: projectToolSubject(event.toolName), status: projectCompletionStatus(event) };
		case "auto_compaction_start":
			return { subject: "context", status: "running" };
		case "auto_compaction_end":
			return { subject: "context", status: projectCompletionStatus(event) };
		case "auto_retry_start":
		case "retry_fallback_applied":
			return { subject: "retry", status: "running" };
		case "auto_retry_end":
		case "retry_fallback_succeeded":
			return { subject: "retry", status: projectCompletionStatus(event) };
		default:
			return undefined;
	}
}
