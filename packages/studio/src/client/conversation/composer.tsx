import type { FormEvent } from "react";
import type { StudioRun } from "../../protocol";

interface StudioComposerProps {
	activeRun?: StudioRun;
	cancelPending: boolean;
	connectionPending: boolean;
	composerBlocked: boolean;
	controlPending: boolean;
	draft: string;
	onCancel(): void;
	onChange(value: string): void;
	onSubmit(event: FormEvent<HTMLFormElement>): void;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	promptPending: boolean;
}

export function StudioComposer({
	activeRun,
	cancelPending,
	connectionPending,
	composerBlocked,
	controlPending,
	draft,
	onCancel,
	onChange,
	onSubmit,
	textareaRef,
	promptPending,
}: StudioComposerProps): React.ReactNode {
	return (
		<form className="studio-composer" onSubmit={onSubmit}>
			<label className="studio-composer-input">
				<span className="studio-sr-only">Message OMP</span>
				<textarea
					ref={textareaRef}
					disabled={composerBlocked}
					onChange={event => onChange(event.target.value)}
					onKeyDown={event => {
						if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={
						connectionPending
							? "OMP is starting this session"
							: activeRun
								? "OMP is working on the current task"
								: "Message OMP about the next task"
					}
					rows={3}
					value={draft}
				/>
			</label>
			<div className="studio-composer-footer">
				<span>
					{connectionPending ? "Connecting to OMP" : activeRun ? "Run in progress" : "Ctrl+Enter to send"}
				</span>
				<div>
					{activeRun && (
						<button
							className="studio-cancel-button"
							disabled={cancelPending || controlPending}
							onClick={onCancel}
							type="button"
						>
							{cancelPending ? "Stopping" : "Stop"}
						</button>
					)}
					<button disabled={composerBlocked || !draft.trim()} type="submit">
						{connectionPending ? "Starting" : promptPending ? "Sending" : "Send"}
					</button>
				</div>
			</div>
		</form>
	);
}
