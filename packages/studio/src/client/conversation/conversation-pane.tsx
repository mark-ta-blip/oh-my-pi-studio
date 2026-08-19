import { type FormEvent, memo } from "react";
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
import { sessionTitle } from "../presentation";
import { StudioComposer } from "./composer";
import { StudioExecutionStrip } from "./execution-strip";
import { StudioTranscriptMessageView } from "./transcript-message";

interface StudioConversationPaneProps {
	activityEntries: StudioActivityEntry[];
	approvals: StudioApproval[];
	cancelPending: boolean;
	connectionPending: boolean;
	composerBlocked: boolean;
	controlPending: boolean;
	draft: string;
	earlierPending: boolean;
	hasEarlierTranscript: boolean;
	hasStreamingAssistant: boolean;
	plan?: StudioPlanSummary;
	onCancel(): void;
	onLoadEarlier(): void;
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

export const StudioConversationPane = memo(function StudioConversationPane({
	activityEntries,
	approvals,
	cancelPending,
	connectionPending,
	composerBlocked,
	controlPending,
	draft,
	earlierPending,
	hasEarlierTranscript,
	hasStreamingAssistant,
	plan,
	onCancel,
	onLoadEarlier,
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
				{hasEarlierTranscript && (
					<div className="studio-transcript-earlier">
						<button disabled={earlierPending} onClick={onLoadEarlier} type="button">
							{earlierPending ? "Loading earlier messages" : "Load earlier messages"}
						</button>
					</div>
				)}
				{connectionPending && (
					<p className="studio-conversation-notice" role="status">
						Starting the OMP session. Type your instruction now and OMP will run it as soon as the session is
						ready.
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
					<StudioTranscriptMessageView key={message.id} message={message} />
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
});
