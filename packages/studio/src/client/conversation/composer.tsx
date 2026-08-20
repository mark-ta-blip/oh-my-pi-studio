import { Image, Paperclip, Send, Square, X } from "lucide-react";
import { type FormEvent, memo, useEffect, useRef } from "react";
import type {
	StudioImageAttachment,
	StudioProviderModel,
	StudioRun,
	StudioSessionMode,
	StudioThinkingLevel,
} from "../../protocol";

export interface StudioComposerImageDraft {
	id: string;
	attachment: StudioImageAttachment;
	name: string;
}

function imageAttachmentLabel(imageCount: number): string {
	return imageCount === 1 ? "1 image attached" : `${imageCount} images attached`;
}

interface StudioComposerProps {
	activeRun?: StudioRun;
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
	onAttachImages(files: FileList): void;
	onModelChange(provider: string, modelId: string): void;
	onThinkingChange(level: StudioThinkingLevel | undefined): void;
	onCancel(): void;
	onChange(value: string): void;
	onRemoveImage(imageId: string): void;
	onSessionModeChange(mode: StudioSessionMode): void;
	onSubmit(event: FormEvent<HTMLFormElement>): void;
	sessionMode: StudioSessionMode;
	sessionModePending: boolean;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	promptPending: boolean;
}

export const StudioComposer = memo(function StudioComposer({
	activeRun,
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
	onAttachImages,
	onCancel,
	onChange,
	onRemoveImage,
	onSessionModeChange,
	onSubmit,
	sessionMode,
	sessionModePending,
	textareaRef,
	promptPending,
}: StudioComposerProps): React.ReactNode {
	const imageInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
	}, [draft, textareaRef]);
	const sendDisabled = composerBlocked || imageAttachmentPending || (!draft.trim() && imageAttachments.length === 0);
	const modeDisabled = composerBlocked || sessionModePending;
	const configurationDisabled = composerBlocked || modelPending || thinkingPending;

	return (
		<form className="studio-composer" onSubmit={onSubmit}>
			<label className="studio-composer-input">
				<span className="studio-sr-only">Message OMP</span>
				<textarea
					ref={textareaRef}
					disabled={composerBlocked}
					onChange={event => onChange(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={
						activeRun
							? "OMP is working on the current task"
							: connectionPending
								? "Type the first instruction while the session starts"
								: "Message OMP about the next task"
					}
					rows={3}
					value={draft}
				/>
			</label>
			{imageAttachments.length > 0 && (
				<div aria-label="Attached images" className="studio-composer-attachments">
					{imageAttachments.map(image => (
						<div className="studio-composer-attachment" key={image.id} title={image.name}>
							<Image aria-hidden="true" size={13} strokeWidth={1.8} />
							<span>{image.name}</span>
							<button
								aria-label={`Remove ${image.name}`}
								disabled={composerBlocked || imageAttachmentPending}
								onClick={() => onRemoveImage(image.id)}
								title={`Remove ${image.name}`}
								type="button"
							>
								<X aria-hidden="true" size={13} strokeWidth={2} />
							</button>
						</div>
					))}
				</div>
			)}
			<div className="studio-composer-footer">
				<div className="studio-composer-controls">
					<div aria-label="Session mode" className="studio-mode-segmented" role="group">
						<button
							aria-pressed={sessionMode === "code"}
							className={sessionMode === "code" ? "studio-mode-option-active" : undefined}
							disabled={modeDisabled}
							onClick={() => onSessionModeChange("code")}
							title="Work directly in the project"
							type="button"
						>
							Code
						</button>
						<button
							aria-pressed={sessionMode === "plan"}
							className={sessionMode === "plan" ? "studio-mode-option-active" : undefined}
							disabled={modeDisabled}
							onClick={() => onSessionModeChange("plan")}
							title="Create and review a plan before coding"
							type="button"
						>
							Plan
						</button>
					</div>
					{modelOptions.length > 0 && (
						<label className="studio-composer-picker">
							<span>Model</span>
							<select
								aria-label="Model"
								disabled={configurationDisabled}
								onChange={event => {
									const [provider, ...idParts] = event.target.value.split("/");
									if (provider && idParts.length > 0) onModelChange(provider, idParts.join("/"));
								}}
								value={selectedModel ? `${selectedModel.providerId}/${selectedModel.id}` : ""}
							>
								{modelOptions.map(model => (
									<option key={`${model.providerId}/${model.id}`} value={`${model.providerId}/${model.id}`}>
										{model.name}
									</option>
								))}
							</select>
						</label>
					)}
					{thinkingLevels && thinkingLevels.length > 0 && (
						<label className="studio-composer-picker studio-composer-thinking-picker">
							<span>Thinking</span>
							<select
								aria-label="Thinking"
								disabled={configurationDisabled}
								onChange={event =>
									onThinkingChange(
										event.target.value ? (event.target.value as StudioThinkingLevel) : undefined,
									)
								}
								value={selectedThinkingLevel ?? ""}
							>
								<option value="">Default</option>
								{thinkingLevels.map(level => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						</label>
					)}
					{imageInputEnabled && (
						<>
							<input
								accept="image/jpeg,image/png,image/webp,image/gif"
								className="studio-image-input"
								disabled={composerBlocked || imageAttachmentPending}
								multiple
								onChange={event => {
									if (event.target.files) onAttachImages(event.target.files);
									event.target.value = "";
								}}
								ref={imageInputRef}
								type="file"
							/>
							<button
								aria-label="Attach image"
								className="studio-attachment-button"
								disabled={composerBlocked || imageAttachmentPending}
								onClick={() => imageInputRef.current?.click()}
								title="Attach image"
								type="button"
							>
								<Paperclip aria-hidden="true" size={15} strokeWidth={1.9} />
							</button>
						</>
					)}
				</div>
				<span>
					{imageAttachmentPending
						? "Preparing image"
						: promptPending && connectionPending
							? "Waiting for the session to start"
							: activeRun
								? "Run in progress"
								: connectionPending
									? "Starting the session - you can type now"
									: imageAttachments.length > 0
										? imageAttachmentLabel(imageAttachments.length)
										: `${draft.length.toLocaleString()} characters`}
				</span>
				<div>
					{activeRun && (
						<button
							className="studio-cancel-button"
							disabled={cancelPending || controlPending}
							onClick={onCancel}
							title="Stop run"
							type="button"
						>
							<Square aria-hidden="true" fill="currentColor" size={11} strokeWidth={1.8} />
							<span>{cancelPending ? "Stopping" : "Stop"}</span>
						</button>
					)}
					<button
						aria-label={promptPending ? "Sending message" : "Send message"}
						className="studio-send-button"
						disabled={sendDisabled}
						title="Send message"
						type="submit"
					>
						{promptPending ? (
							<span aria-hidden="true" className="studio-button-spinner" />
						) : (
							<Send aria-hidden="true" size={16} strokeWidth={2} />
						)}
					</button>
				</div>
			</div>
		</form>
	);
});
