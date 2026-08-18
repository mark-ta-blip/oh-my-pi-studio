import type { StudioTranscriptMessage } from "../protocol";

function compareTranscriptMessages(left: StudioTranscriptMessage, right: StudioTranscriptMessage): number {
	return (
		left.createdAtMs - right.createdAtMs || left.updatedAtMs - right.updatedAtMs || left.id.localeCompare(right.id)
	);
}

function insertTranscriptMessage(
	messages: StudioTranscriptMessage[],
	message: StudioTranscriptMessage,
): StudioTranscriptMessage[] {
	const index = messages.findIndex(current => compareTranscriptMessages(message, current) < 0);
	if (index < 0) return [...messages, message];
	return [...messages.slice(0, index), message, ...messages.slice(index)];
}

function replaceTranscriptMessage(
	messages: StudioTranscriptMessage[],
	index: number,
	message: StudioTranscriptMessage,
): StudioTranscriptMessage[] {
	const existing = messages[index];
	if (compareTranscriptMessages(existing, message) === 0) {
		const next = [...messages];
		next[index] = { ...existing, ...message };
		return next;
	}
	return insertTranscriptMessage([...messages.slice(0, index), ...messages.slice(index + 1)], message);
}

function shouldKeepTranscriptMessage(existing: StudioTranscriptMessage, incoming: StudioTranscriptMessage): boolean {
	return (
		existing.updatedAtMs > incoming.updatedAtMs ||
		(existing.updatedAtMs === incoming.updatedAtMs &&
			((existing.status !== "streaming" && incoming.status === "streaming") ||
				existing.text.length > incoming.text.length))
	);
}

/** Apply a newer Studio transcript snapshot while preserving chronological conversation order. */
export function upsertStudioTranscriptMessage(
	messages: StudioTranscriptMessage[],
	message: StudioTranscriptMessage,
): StudioTranscriptMessage[] {
	const existingIndex = messages.findIndex(current => current.id === message.id);
	if (existingIndex >= 0) {
		const existing = messages[existingIndex];
		if (shouldKeepTranscriptMessage(existing, message)) return messages;
		return replaceTranscriptMessage(messages, existingIndex, message);
	}

	const optimisticIndex = messages.findIndex(
		current =>
			(current.id.startsWith("local_") || message.id.startsWith("local_")) &&
			current.role === message.role &&
			current.text === message.text &&
			Math.abs(current.createdAtMs - message.createdAtMs) < 30_000,
	);
	if (optimisticIndex >= 0) {
		if (message.id.startsWith("local_")) return messages;
		return replaceTranscriptMessage(messages, optimisticIndex, message);
	}

	return insertTranscriptMessage(messages, message);
}

/** Merge a REST snapshot without allowing it to roll back fresher WebSocket state. */
export function mergeStudioTranscriptSnapshot(
	messages: StudioTranscriptMessage[],
	snapshot: StudioTranscriptMessage[],
): StudioTranscriptMessage[] {
	return snapshot.reduce(upsertStudioTranscriptMessage, messages);
}
