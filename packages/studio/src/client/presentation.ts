import type { StudioActivityEntry, StudioRun, StudioSession, StudioTranscriptMessage } from "../protocol";

export function formatWorkspaceDate(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(timestamp);
}

export function formatCount(value: number): string {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function formatCost(value: number): string {
	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 4,
		minimumFractionDigits: value > 0 ? 2 : 0,
	}).format(value);
}

export function sessionTitle(session: StudioSession): string {
	return session.name ?? `Session ${session.id.slice(4, 12)}`;
}

export function formatShortTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

export function transcriptDisplayText(message: StudioTranscriptMessage): string {
	if (message.text) return message.text;
	if (message.role !== "assistant") return "";
	if (message.status === "failed") return "OMP could not complete this response. Review the run status for details.";
	if (message.status === "interrupted") return "OMP stopped this response.";
	return "";
}

export function runFailureMessage(run: StudioRun): string {
	switch (run.failureKind) {
		case "authentication":
			return "The provider session is not authenticated. Reconnect the provider and try again.";
		case "rate_limit":
			return "The provider rate limit or usage quota was reached. Wait briefly or choose another model.";
		case "context_limit":
			return "This conversation is too large for the selected model. Start a fresh session or use a larger context model.";
		case "connection":
			return "The provider connection was interrupted. Check the connection and retry.";
		case "policy":
			return "The provider refused this request due to its safety or account policy.";
		case "provider":
			return "The provider returned an error. Review the model connection and try again.";
		default:
			return "OMP could not complete this response. Try again or choose another model.";
	}
}

const ACTIVITY_SUBJECT_LABELS: Record<StudioActivityEntry["subject"], string> = {
	agent: "Agent",
	command: "Command",
	context: "Context update",
	file_read: "File read",
	file_search: "File search",
	file_write: "File write",
	retry: "Retry",
	system: "System work",
	task: "Task",
	tool: "Tool",
	web: "Web request",
};

const ACTIVITY_STATUS_LABELS: Record<StudioActivityEntry["status"], string> = {
	cancelled: "was cancelled",
	completed: "completed",
	failed: "failed",
	running: "is running",
};

export function activityLabel(entry: StudioActivityEntry): string {
	return `${ACTIVITY_SUBJECT_LABELS[entry.subject]} ${ACTIVITY_STATUS_LABELS[entry.status]}.`;
}
