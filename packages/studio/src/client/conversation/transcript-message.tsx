import { Bot, UserRound } from "lucide-react";
import { memo } from "react";
import type { StudioTranscriptMessage } from "../../protocol";
import { formatShortTime, transcriptDisplayText } from "../presentation";
import { StudioMarkdown } from "./markdown";

interface StudioTranscriptMessageViewProps {
	message: StudioTranscriptMessage;
}

/**
 * One linear transcript entry, memoized on the message object.
 *
 * Streaming updates arrive roughly every 50ms and only ever replace the message being written, so
 * every settled bubble keeps its identity and skips re-rendering. Without this, a long conversation
 * re-renders in full 20 times a second and the chat area feels frozen while typing.
 */
export const StudioTranscriptMessageView = memo(function StudioTranscriptMessageView({
	message,
}: StudioTranscriptMessageViewProps): React.ReactNode {
	const role = message.role === "user" ? "You" : "OMP";
	const status =
		message.status === "streaming"
			? "Streaming"
			: message.status === "failed"
				? "Stopped"
				: message.status === "interrupted"
					? "Interrupted"
					: undefined;

	return (
		<article aria-label={role} className={`studio-message studio-message-${message.role}`}>
			<div aria-hidden="true" className="studio-message-avatar">
				{message.role === "user" ? <UserRound size={16} strokeWidth={1.9} /> : <Bot size={16} strokeWidth={1.9} />}
			</div>
			<div className="studio-message-content">
				<div className="studio-message-meta">
					<strong>{role}</strong>
					<time dateTime={new Date(message.createdAtMs).toISOString()}>
						{formatShortTime(message.createdAtMs)}
					</time>
				</div>
				<div className="studio-message-body">
					<StudioMarkdown text={transcriptDisplayText(message)} />
				</div>
				{status && (
					<span
						className={
							message.status === "streaming"
								? "studio-message-status studio-message-status-streaming"
								: "studio-message-status studio-message-status-failed"
						}
					>
						{status}
					</span>
				)}
			</div>
		</article>
	);
});
