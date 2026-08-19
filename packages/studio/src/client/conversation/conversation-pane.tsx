import type { FormEvent } from "react";
import type {
	StudioActivityEntry,
	StudioApproval,
	StudioPlanSummary,
	StudioRun,
	StudioSession,
	StudioToolDisplay,
	StudioTranscriptMessage,
	StudioWorkspace,
} from "../../protocol";
import type { StudioContextPanel } from "../context-panel";
import { formatShortTime, sessionTitle, transcriptDisplayText } from "../presentation";
import { StudioComposer } from "./composer";
import { StudioExecutionStrip } from "./execution-strip";

interface StudioConversationPaneProps {
	activityEntries: StudioActivityEntry[];
	approvals: StudioApproval[];
	cancelPending: boolean;
	connectionPending: boolean;
	composerBlocked: boolean;
	controlPending: boolean;
	draft: string;
	hasStreamingAssistant: boolean;
	plan?: StudioPlanSummary;
	onCancel(): void;
	onReconnect(): void;
	onDraftChange(value: string): void;
	onOpenContext(panel: StudioContextPanel): void;
	onOpenNavigation(): void;
	onOpenSetup(): void;
	onScroll(scrollHeight: number, scrollTop: number, clientHeight: number): void;
	onSubmit(event: FormEvent<HTMLFormElement>): void;
	selectedActiveRun?: StudioRun;
	selectedSession?: StudioSession;
	selectedWorkspace?: StudioWorkspace;
	sessionError: string | null;
	scrollRef: React.RefObject<HTMLElement | null>;
	toolCards: StudioToolDisplay[];
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	transcript: StudioTranscriptMessage[];
	transcriptError: string | null;
	transcriptLoading: boolean;
	promptPending: boolean;
}

export function StudioConversationPane({
	activityEntries,
	approvals,
	cancelPending,
	connectionPending,
	composerBlocked,
	controlPending,
	draft,
	hasStreamingAssistant,
	plan,
	onCancel,
	onReconnect,
	onDraftChange,
	onOpenContext,
	onOpenNavigation,
	onOpenSetup,
	onScroll,
	onSubmit,
	promptPending,
	selectedActiveRun,
	selectedSession,
	selectedWorkspace,
	sessionError,
	scrollRef,
	toolCards,
	textareaRef,
	transcript,
	transcriptError,
	transcriptLoading,
}: StudioConversationPaneProps): React.ReactNode {
	if (!selectedSession) {
		return (
			<main aria-label="Conversation" className="studio-conversation-pane">
				<section className="studio-no-session">
					<span className="studio-empty-conversation-mark">OMP</span>
					<h1>Open a focused session</h1>
					<p>Choose a local project and provider once, then work in a persistent conversation.</p>
					<button onClick={onOpenSetup} type="button">
						New session
					</button>
					{sessionError && <p className="studio-inline-error">{sessionError}</p>}
				</section>
			</main>
		);
	}

	return (
		<main aria-label="Conversation" className="studio-conversation-pane">
			<header className="studio-conversation-header">
				<div>
					<span className="studio-section-kicker">Active session</span>
					<div className="studio-conversation-breadcrumb">
						<span>{selectedWorkspace?.label ?? "Project"}</span>
						<span>/</span>
						<span>{selectedSession.model?.provider ?? "OMP"}</span>
					</div>
					<h1>{sessionTitle(selectedSession)}</h1>
				</div>
				<div className="studio-conversation-header-actions">
					<span className={`studio-session-status studio-session-status-${selectedSession.status}`}>
						{selectedActiveRun ? "running" : selectedSession.status}
					</span>
					{(connectionPending || selectedSession.status === "failed") && (
						<button disabled={connectionPending} onClick={onReconnect} type="button">
							{connectionPending ? "Connecting" : "Reconnect"}
						</button>
					)}
					<button onClick={onOpenSetup} type="button">
						Configure
					</button>
					<button className="studio-context-toggle" onClick={() => onOpenContext("overview")} type="button">
						Context
					</button>
					<button className="studio-mobile-navigation-toggle" onClick={onOpenNavigation} type="button">
						Sessions
					</button>
				</div>
			</header>

			<StudioExecutionStrip
				activeRun={selectedActiveRun}
				activityEntries={activityEntries}
				approvals={approvals}
				onOpenContext={onOpenContext}
				plan={plan}
				toolCards={toolCards}
			/>

			<section
				aria-live="polite"
				className="studio-conversation-scroll"
				onScroll={event => {
					const conversation = event.currentTarget;
					onScroll(conversation.scrollHeight, conversation.scrollTop, conversation.clientHeight);
				}}
				ref={scrollRef}
			>
				{connectionPending && (
					<p className="studio-conversation-notice" role="status">
						Starting the OMP session. Your first instruction will be available as soon as the connection is ready.
					</p>
				)}
				{selectedSession.status === "failed" && !connectionPending && (
					<p className="studio-conversation-recovery" role="status">
						OMP could not start this session. Reconnect to try again; your project files are unchanged.
					</p>
				)}
				{selectedSession.status === "interrupted" && !selectedActiveRun && (
					<p className="studio-conversation-recovery">
						The last run was interrupted. Review the session history before sending the next instruction.
					</p>
				)}
				{transcriptLoading && transcript.length === 0 && (
					<p className="studio-conversation-notice">Loading conversation...</p>
				)}
				{!transcriptLoading && transcript.length === 0 && !hasStreamingAssistant && (
					<div className="studio-empty-conversation">
						<span className="studio-empty-conversation-mark">OMP</span>
						<h2>Start the conversation</h2>
						<p>Send a task to this session. Replies and live updates stay here as the work progresses.</p>
					</div>
				)}
				{transcript.map(message => (
					<article className={`studio-message studio-message-${message.role}`} key={message.id}>
						<div className="studio-message-meta">
							<span>{message.role === "user" ? "You" : "OMP"}</span>
							<time dateTime={new Date(message.createdAtMs).toISOString()}>
								{formatShortTime(message.createdAtMs)}
							</time>
							{message.status === "streaming" && <span className="studio-message-streaming">Streaming</span>}
							{message.status === "failed" && <span className="studio-message-failed">Stopped</span>}
							{message.status === "interrupted" && <span className="studio-message-failed">Interrupted</span>}
						</div>
						<p>{transcriptDisplayText(message)}</p>
					</article>
				))}
				{selectedActiveRun && hasStreamingAssistant && (
					<div className="studio-run-indicator">
						<span />
						OMP is working
					</div>
				)}
			</section>

			<StudioComposer
				activeRun={selectedActiveRun}
				cancelPending={cancelPending}
				connectionPending={connectionPending}
				composerBlocked={composerBlocked}
				controlPending={controlPending}
				draft={draft}
				onCancel={onCancel}
				onChange={onDraftChange}
				onSubmit={onSubmit}
				promptPending={promptPending}
				textareaRef={textareaRef}
			/>
			{transcriptError && <p className="studio-inline-error">{transcriptError}</p>}
			{sessionError && <p className="studio-inline-error">{sessionError}</p>}
		</main>
	);
}
