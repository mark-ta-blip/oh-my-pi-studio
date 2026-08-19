import { useEffect, useMemo, useState } from "react";
import type {
	StudioChangeFile,
	StudioChangePreviewHunk,
	StudioChangePreviewLine,
	StudioChangeSet,
	StudioChangeStatus,
} from "../../protocol";
import { formatCount, formatShortTime } from "../presentation";

const CHANGE_STATUS_LABELS: Record<StudioChangeStatus, string> = {
	added: "Added",
	conflicted: "Conflicted",
	deleted: "Deleted",
	modified: "Modified",
	renamed: "Renamed",
	untracked: "Untracked",
};

const CHANGE_LINE_PREFIXES: Record<StudioChangePreviewLine["kind"], string> = {
	addition: "+",
	context: " ",
	deletion: "-",
};

function changeScope(file: StudioChangeFile): string {
	if (file.untracked) return "untracked";
	if (file.staged && file.unstaged) return "staged + unstaged";
	if (file.staged) return "staged";
	if (file.unstaged) return "unstaged";
	return "no worktree change";
}

/** Compact per-file metrics for the file list and the preview header. */
function changeMetrics(file: StudioChangeFile): string {
	const parts = [`+${formatCount(file.additions)}`, `-${formatCount(file.deletions)}`, changeScope(file)];
	if (file.binary) parts.push("binary");
	return parts.join(" / ");
}

function hunkRange(hunk: StudioChangePreviewHunk): string {
	return `@@ -${hunk.oldStart},${hunk.oldLineCount} +${hunk.newStart},${hunk.newLineCount} @@`;
}

/** The reason a server-projected file carries no readable diff, if any. */
function previewNotice(file: StudioChangeFile): string | undefined {
	if (file.binary) return "Binary file. OMP Studio does not preview binary content.";
	if (file.previewOmitted) return "This diff was too large to project, so its preview was omitted.";
	if (file.hunks.length === 0) return "No preview lines were projected for this file.";
	return undefined;
}

interface StudioChangeReviewProps {
	changeSet?: StudioChangeSet;
	enabled: boolean;
	error: string | null;
	loading: boolean;
	onRefresh(): void;
}

/** Uncommitted workspace changes rendered from a bounded, server-projected review snapshot. */
export function StudioChangeReview({
	changeSet,
	enabled,
	error,
	loading,
	onRefresh,
}: StudioChangeReviewProps): React.ReactNode {
	const files = useMemo(() => changeSet?.files ?? [], [changeSet]);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	useEffect(() => {
		setSelectedPath(current =>
			current && files.some(file => file.path === current) ? current : (files[0]?.path ?? null),
		);
	}, [files]);

	const selectedFile = useMemo(() => files.find(file => file.path === selectedPath), [files, selectedPath]);

	if (!enabled) return null;

	const selectedNotice = selectedFile ? previewNotice(selectedFile) : undefined;

	return (
		<section className="studio-inspector-section studio-change-review-section">
			<div className="studio-inspector-heading">
				<h2>Changes</h2>
				<div className="studio-change-review-actions">
					<span>{files.length} files</span>
					<button aria-label="Refresh workspace changes" disabled={loading} onClick={onRefresh} type="button">
						Refresh
					</button>
				</div>
			</div>

			{error ? (
				<p className="studio-inspector-empty">{error}</p>
			) : loading && files.length === 0 ? (
				<p className="studio-inspector-empty">Loading workspace changes.</p>
			) : !changeSet || files.length === 0 ? (
				<p className="studio-inspector-empty">Uncommitted changes will appear here.</p>
			) : (
				<div className="studio-change-review-content">
					<div className="studio-change-summary">
						<span>+{formatCount(changeSet.additions)}</span>
						<span>-{formatCount(changeSet.deletions)}</span>
						<span>
							{formatCount(changeSet.stagedFileCount)} staged / {formatCount(changeSet.unstagedFileCount)}{" "}
							unstaged / {formatCount(changeSet.untrackedFileCount)} untracked
						</span>
						<time dateTime={new Date(changeSet.generatedAtMs).toISOString()}>
							{formatShortTime(changeSet.generatedAtMs)}
						</time>
					</div>

					{changeSet.truncated && (
						<p className="studio-change-review-notice">
							This workspace has more changes than OMP Studio reviews at once. Commit or stage some work, then
							refresh.
						</p>
					)}

					<div className="studio-change-file-list" role="list">
						{files.map(file => (
							<button
								aria-pressed={selectedFile?.path === file.path}
								className={
									selectedFile?.path === file.path
										? "studio-change-file studio-change-file-selected"
										: "studio-change-file"
								}
								key={file.path}
								onClick={() => setSelectedPath(file.path)}
								title={file.path}
								type="button"
							>
								<span>{file.path}</span>
								<small>
									{CHANGE_STATUS_LABELS[file.status]} / {changeMetrics(file)}
								</small>
							</button>
						))}
					</div>

					{selectedFile && (
						<div className="studio-change-preview">
							<div className="studio-change-preview-header">
								<strong title={selectedFile.path}>{selectedFile.path}</strong>
								<span>
									{CHANGE_STATUS_LABELS[selectedFile.status]} / {changeMetrics(selectedFile)}
								</span>
							</div>
							{selectedNotice ? (
								<p>{selectedNotice}</p>
							) : (
								<>
									{selectedFile.previewTruncated && (
										<p className="studio-change-preview-limit">
											This preview is shortened. Open the file in your editor for the full diff.
										</p>
									)}
									<div className="studio-change-hunks">
										{selectedFile.hunks.map(hunk => (
											<div className="studio-change-hunk" key={hunkRange(hunk)}>
												<header>{hunkRange(hunk)}</header>
												<pre>
													{hunk.lines.map((line, lineIndex) => (
														<span
															className={`studio-change-line studio-change-line-${line.kind}`}
															key={`${lineIndex}:${line.kind}:${line.text}`}
														>
															{CHANGE_LINE_PREFIXES[line.kind]}
															{line.text}
														</span>
													))}
												</pre>
												{hunk.truncated && <p>Remaining lines in this hunk were omitted.</p>}
											</div>
										))}
									</div>
								</>
							)}
						</div>
					)}
				</div>
			)}
		</section>
	);
}
