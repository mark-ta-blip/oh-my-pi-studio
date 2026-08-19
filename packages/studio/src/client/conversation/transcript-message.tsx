import { memo } from "react";
import type { StudioTranscriptMessage } from "../../protocol";
import { formatShortTime, transcriptDisplayText } from "../presentation";

interface StudioTranscriptMessageViewProps {
	message: StudioTranscriptMessage;
}

/**
 * One transcript bubble, memoized on the message object.
 *
 * Streaming updates arrive roughly every 50ms and only ever replace the message being written, so
 * every settled bubble keeps its identity and skips re-rendering. Without this, a long conversation
 * re-renders in full 20 times a second and the chat area feels frozen while typing.
 */
export const StudioTranscriptMessageView = memo(function StudioTranscriptMessageView({
	message,
}: StudioTranscriptMessageViewProps): React.ReactNode {
	return (
		<article className={`studio-message studio-message-${message.role}`}>
			<div className="studio-message-meta">
				<span>{message.role === "user" ? "You" : "OMP"}</span>
				<time dateTime={new Date(message.createdAtMs).toISOString()}>{formatShortTime(message.createdAtMs)}</time>
				{message.status === "streaming" && <span className="studio-message-streaming">Streaming</span>}
				{message.status === "failed" && <span className="studio-message-failed">Stopped</span>}
				{message.status === "interrupted" && <span className="studio-message-failed">Interrupted</span>}
			</div>
			<p>{transcriptDisplayText(message)}</p>
		</article>
	);
});
