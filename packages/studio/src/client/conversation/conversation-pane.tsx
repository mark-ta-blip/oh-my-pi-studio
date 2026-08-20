import { PanelRight, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import { type FormEvent, memo } from "react";
import type {
	StudioProviderModel,
	StudioRun,
	StudioSession,
	StudioSessionMode,
	StudioThinkingLevel,
	StudioTranscriptMessage,
	StudioWorkspace,
} from "../../protocol";
import type { StudioContextPanel } from "../context-panel";
import { sessionTitle } from "../presentation";
import { StudioComposer, type StudioComposerImageDraft } from "./composer";
import { StudioTranscriptMessageView } from "./transcript-message";

interface StudioConversationPaneProps {
	cancelPending: boolean;
	connectionPending: boolean;
	composerBlocked: boolean;
	controlPending: boolean;
	draft: string;
	imageAttachmentPending: boolean;
	imageAttachments: StudioComposerImageDraft[];
	imageInputEnabled: boolean;
	modelOptions: StudioProviderModel[];
	selectedModel?: StudioProviderModel;
	modelPending: boolean;
	thinkingLevels?: StudioThinkingLevel[];
	selectedThinkingLevel?: StudioThinkingLevel;
	thinkingPending: boolean;
	earlierPending: boolean;
	hasEarlierTranscript: boolean;
	hasStreamingAssistant: boolean;
	onAttachImages(files: FileList): void;
	onModelChange(provider: string, modelId: string): void;
	onThinkingChange(level: StudioThinkingLevel | undefined): void;
	onCancel(): void;
	onLoadEarlier(): void;
	onReconnect(): void;
	onDraftChange(value: string): void;
	onOpenContext(panel: StudioContextPanel): void;
	onOpenSetup(): void;
	onRemoveImage(imageId: string): void;
	onSessionModeChange(mode: StudioSessionMode): void;
	onScroll(scrollHeight: number, scrollTop: number, clientHeight: number): void;
	onSubmit(event: FormEvent<HTMLFormElement>): void;
	selectedActiveRun?: StudioRun;
	selectedSession?: StudioSession;
	selectedWorkspace?: StudioWorkspace;
	sessionModePending: boolean;
	sessionError: string | null;
	scrollRef: React.RefObject<HTMLElement | null>;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	transcript: StudioTranscriptMessage[];
	transcriptError: string | null;
	transcriptLoading: boolean;
	promptPending: boolean;
}

export const StudioConversationPane = memo(function StudioConversationPane({
	cancelPending,
	connectionPending,
	composerBlocked,
	controlPending,
	draft,
	imageAttachmentPending,
	imageAttachments,
	imageInputEnabled,
	modelOptions,
	selectedModel,
	modelPending,
	thinkingLevels,
	selectedThinkingLevel,
	thinkingPending,
	onModelChange,
	onThinkingChange,
	earlierPending,
	hasEarlierTranscript,
	hasStreamingAssistant,
	onAttachImages,
	onCancel,
	onLoadEarlier,
	onReconnect,
	onDraftChange,
	onOpenContext,
	onOpenSetup,
	onRemoveImage,
	onScroll,
	onSessionModeChange,
	onSubmit,
	promptPending,
	selectedActiveRun,
	selectedSession,
	selectedWorkspace,
	sessionModePending,
	sessionError,
	scrollRef,
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
						<Plus aria-hidden="true" size={16} strokeWidth={2} />
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
							<RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
							{connectionPending ? "Connecting" : "Reconnect"}
						</button>
					)}
					<button aria-label="Configure session" onClick={onOpenSetup} title="Configure session" type="button">
						<SlidersHorizontal aria-hidden="true" size={15} strokeWidth={1.8} />
					</button>
					<button
						aria-label="Open session context"
						className="studio-context-toggle"
						onClick={() => onOpenContext("overview")}
						title="Session context"
						type="button"
					>
						<PanelRight aria-hidden="true" size={15} strokeWidth={1.8} />
					</button>
				</div>
			</header>

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
				imageAttachmentPending={imageAttachmentPending}
				imageAttachments={imageAttachments}
				imageInputEnabled={imageInputEnabled}
				modelOptions={modelOptions}
				selectedModel={selectedModel}
				modelPending={modelPending}
				thinkingLevels={thinkingLevels}
				selectedThinkingLevel={selectedThinkingLevel}
				thinkingPending={thinkingPending}
				onAttachImages={onAttachImages}
				onModelChange={onModelChange}
				onThinkingChange={onThinkingChange}
				onCancel={onCancel}
				onChange={onDraftChange}
				onRemoveImage={onRemoveImage}
				onSessionModeChange={onSessionModeChange}
				onSubmit={onSubmit}
				promptPending={promptPending}
				sessionMode={selectedSession.mode ?? "code"}
				sessionModePending={sessionModePending}
				textareaRef={textareaRef}
			/>
			{transcriptError && <p className="studio-inline-error">{transcriptError}</p>}
			{sessionError && <p className="studio-inline-error">{sessionError}</p>}
		</main>
	);
});
