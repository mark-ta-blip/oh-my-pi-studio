import { memo } from "react";
import type {
	StudioActivityEntry,
	StudioApproval,
	StudioChangeSet,
	StudioPlanSummary,
	StudioRun,
	StudioSession,
	StudioSubagent,
	StudioToolDisplay,
	StudioUsageHistoryEntry,
	StudioWorkspace,
} from "../../protocol";
import { StudioChangeReview } from "../changes/change-review";
import { STUDIO_CONTEXT_PANELS, type StudioContextPanel, studioContextPanelLabel } from "../context-panel";
import { StudioRunHistory } from "../history/run-history";
import { activityLabel, formatCost, formatCount, formatShortTime } from "../presentation";

function toolDisplayLabel(kind: StudioToolDisplay["kind"]): string {
	switch (kind) {
		case "command":
			return "Command";
		case "file_read":
			return "Read file";
		case "file_write":
			return "Updated file";
		case "file_search":
			return "Searched files";
		case "web":
			return "Web request";
		case "task":
			return "Task";
		case "tool":
			return "Tool";
	}
}

function subagentMetrics(subagent: StudioSubagent): string | undefined {
	const metrics = [
		subagent.requestCount === undefined ? undefined : `${formatCount(subagent.requestCount)} requests`,
		subagent.toolCount === undefined ? undefined : `${formatCount(subagent.toolCount)} tools`,
		subagent.tokenCount === undefined ? undefined : `${formatCount(subagent.tokenCount)} tokens`,
		subagent.cost === undefined ? undefined : `$${formatCost(subagent.cost)}`,
	].filter((metric): metric is string => metric !== undefined);
	return metrics.length > 0 ? metrics.join(" / ") : undefined;
}

interface StudioSessionInspectorProps {
	activePanel: StudioContextPanel;
	activityEnabled: boolean;
	activityEntries: StudioActivityEntry[];
	activityError: string | null;
	activityLoading: boolean;
	changeReviewEnabled: boolean;
	changeSet?: StudioChangeSet;
	changeSetError: string | null;
	changeSetLoading: boolean;
	plan?: StudioPlanSummary;
	planEnabled: boolean;
	planError: string | null;
	planLoading: boolean;
	runHistory: StudioRun[];
	runHistoryEnabled: boolean;
	runHistoryError: string | null;
	runHistoryLoading: boolean;
	approvalEnabled: boolean;
	approvalPendingId: string | null;
	approvals: StudioApproval[];
	controlPendingId: string | null;
	leaseExpiresAtMs: number;
	onAcquireControl(studioSessionId: string): void;
	onClose(): void;
	onPanelChange(panel: StudioContextPanel): void;
	onOpenSetup(): void;
	onRefreshChanges(): void;
	onRefreshHistory(): void;
	onResolveApproval(approval: StudioApproval, decision: "approve" | "reject"): void;
	selectedActiveRun?: StudioRun;
	selectedSession?: StudioSession;
	selectedWorkspace?: StudioWorkspace;
	subagents: StudioSubagent[];
	subagentEnabled: boolean;
	toolCards: StudioToolDisplay[];
	toolCardsEnabled: boolean;
	toolCardsError: string | null;
	toolCardsLoading: boolean;
	usageEnabled: boolean;
	usageHistory: StudioUsageHistoryEntry[];
}

export const StudioSessionInspector = memo(function StudioSessionInspector({
	activePanel,
	activityEnabled,
	activityEntries,
	activityError,
	activityLoading,
	changeReviewEnabled,
	changeSet,
	changeSetError,
	changeSetLoading,
	plan,
	planEnabled,
	planError,
	planLoading,
	runHistory,
	runHistoryEnabled,
	runHistoryError,
	runHistoryLoading,
	approvalEnabled,
	approvalPendingId,
	approvals,
	controlPendingId,
	leaseExpiresAtMs,
	onAcquireControl,
	onClose,
	onPanelChange,
	onOpenSetup,
	onRefreshChanges,
	onRefreshHistory,
	onResolveApproval,
	selectedActiveRun,
	selectedSession,
	selectedWorkspace,
	subagents,
	subagentEnabled,
	toolCards,
	toolCardsEnabled,
	toolCardsError,
	toolCardsLoading,
	usageEnabled,
	usageHistory,
}: StudioSessionInspectorProps): React.ReactNode {
	const pendingApprovalCount = approvals.filter(approval => approval.status === "pending").length;

	return (
		<aside aria-label="Run context" className="studio-inspector">
			<header className="studio-inspector-topline">
				<div>
					<span className="studio-section-kicker">Run context</span>
					<strong>{studioContextPanelLabel(activePanel)}</strong>
				</div>
				<div className="studio-inspector-topline-actions">
					<button onClick={onOpenSetup} type="button">
						Setup
					</button>
					<button aria-label="Close run context" onClick={onClose} type="button">
						Close
					</button>
				</div>
			</header>

			<nav aria-label="Run context sections" className="studio-context-tabs">
				{STUDIO_CONTEXT_PANELS.map(panel => (
					<button
						aria-current={activePanel === panel ? "page" : undefined}
						className={
							activePanel === panel ? "studio-context-tab studio-context-tab-active" : "studio-context-tab"
						}
						onClick={() => onPanelChange(panel)}
						key={panel}
						type="button"
					>
						{studioContextPanelLabel(panel)}
					</button>
				))}
			</nav>

			{!selectedSession ? (
				<p className="studio-inspector-empty studio-inspector-start">
					Select or start a session to inspect its run context.
				</p>
			) : (
				<>
					{activePanel === "overview" && (
						<>
							<section className="studio-inspector-section studio-context-hero">
								<div className="studio-inspector-heading">
									<div>
										<span className="studio-section-kicker">Session</span>
										<h2>{selectedWorkspace?.label ?? "Current project"}</h2>
									</div>
									<span className={`studio-session-status studio-session-status-${selectedSession.status}`}>
										{selectedActiveRun ? "active" : selectedSession.status}
									</span>
								</div>
								<dl className="studio-inspector-facts">
									<div>
										<dt>Model</dt>
										<dd>
											{selectedSession.model
												? `${selectedSession.model.provider}/${selectedSession.model.id}`
												: "Unavailable"}
										</dd>
									</div>
									<div>
										<dt>Control</dt>
										<dd>{leaseExpiresAtMs > Date.now() ? "Held by this window" : "Not held"}</dd>
									</div>
								</dl>
								<button
									className="studio-inspector-control"
									disabled={controlPendingId !== null}
									onClick={() => onAcquireControl(selectedSession.id)}
									type="button"
								>
									{controlPendingId === selectedSession.id
										? "Claiming control"
										: leaseExpiresAtMs > Date.now()
											? "Renew control"
											: "Take control"}
								</button>
							</section>

							{usageEnabled && (
								<section className="studio-inspector-section">
									<div className="studio-inspector-heading">
										<h2>Usage</h2>
										<span>{selectedSession.usage ? "Latest" : "Waiting"}</span>
									</div>
									{selectedSession.usage ? (
										<dl className="studio-usage-grid">
											<div>
												<dt>Tokens</dt>
												<dd>{formatCount(selectedSession.usage.totalTokens)}</dd>
											</div>
											<div>
												<dt>Tools</dt>
												<dd>{formatCount(selectedSession.usage.toolCalls)}</dd>
											</div>
											<div>
												<dt>Cost</dt>
												<dd>${formatCost(selectedSession.usage.cost)}</dd>
											</div>
										</dl>
									) : (
										<p className="studio-inspector-empty">Usage appears after the first response.</p>
									)}
								</section>
							)}

							{planEnabled && (
								<section className="studio-inspector-section">
									<div className="studio-inspector-heading">
										<h2>Plan</h2>
										<span>
											{plan
												? `${formatCount(plan.completedTaskCount)}/${formatCount(plan.totalTaskCount)}`
												: "Waiting"}
										</span>
									</div>
									{planError ? (
										<p className="studio-inspector-empty">{planError}</p>
									) : planLoading && !plan ? (
										<p className="studio-inspector-empty">Loading plan progress.</p>
									) : !plan ? (
										<p className="studio-inspector-empty">
											Plan progress will appear when OMP records tasks.
										</p>
									) : (
										<dl className="studio-plan-grid">
											<div>
												<dt>Done</dt>
												<dd>{formatCount(plan.completedTaskCount)}</dd>
											</div>
											<div>
												<dt>Active</dt>
												<dd>{formatCount(plan.inProgressTaskCount)}</dd>
											</div>
											<div>
												<dt>Waiting</dt>
												<dd>{formatCount(plan.pendingTaskCount)}</dd>
											</div>
											<div>
												<dt>Blocked</dt>
												<dd>{formatCount(plan.blockedTaskCount)}</dd>
											</div>
										</dl>
									)}
								</section>
							)}

							{approvalEnabled && (
								<section aria-live="polite" className="studio-inspector-section">
									<div className="studio-inspector-heading">
										<h2>Approvals</h2>
										<span>{pendingApprovalCount} waiting</span>
									</div>
									{approvals.length === 0 ? (
										<p className="studio-inspector-empty">No tool decision is waiting.</p>
									) : (
										<div className="studio-approval-list">
											{approvals.map(approval => (
												<article
													className={`studio-approval-card studio-approval-card-${approval.status}`}
													key={approval.id}
												>
													<div>
														<strong>{approval.toolName}</strong>
														<span>{approval.status}</span>
													</div>
													{approval.reason && <p>{approval.reason}</p>}
													{approval.status === "pending" && (
														<div className="studio-approval-actions">
															<button
																disabled={approvalPendingId !== null || controlPendingId !== null}
																onClick={() => onResolveApproval(approval, "approve")}
																type="button"
															>
																Approve
															</button>
															<button
																className="studio-approval-reject"
																disabled={approvalPendingId !== null || controlPendingId !== null}
																onClick={() => onResolveApproval(approval, "reject")}
																type="button"
															>
																Reject
															</button>
														</div>
													)}
												</article>
											))}
										</div>
									)}
								</section>
							)}

							{subagentEnabled && subagents.length > 0 && (
								<section className="studio-inspector-section">
									<div className="studio-inspector-heading">
										<h2>Subagents</h2>
										<span>{subagents.length}</span>
									</div>
									<div className="studio-subagent-list">
										{subagents.map(subagent => (
											<div className="studio-subagent-row" key={subagent.id}>
												<div>
													<strong>{subagent.agent}</strong>
													{subagentMetrics(subagent) && <small>{subagentMetrics(subagent)}</small>}
												</div>
												<span>{subagent.status}</span>
											</div>
										))}
									</div>
								</section>
							)}
						</>
					)}

					{activePanel === "history" &&
						(runHistoryEnabled ? (
							<StudioRunHistory
								activityEntries={activityEntries}
								enabled={runHistoryEnabled}
								error={runHistoryError}
								loading={runHistoryLoading}
								onRefresh={onRefreshHistory}
								runs={runHistory}
								usageEntries={usageHistory}
							/>
						) : (
							<p className="studio-inspector-empty studio-inspector-start">
								Run history is unavailable for this session.
							</p>
						))}

					{activePanel === "changes" &&
						(changeReviewEnabled ? (
							<StudioChangeReview
								changeSet={changeSet}
								enabled={changeReviewEnabled}
								error={changeSetError}
								loading={changeSetLoading}
								onRefresh={onRefreshChanges}
							/>
						) : (
							<p className="studio-inspector-empty studio-inspector-start">
								Change review is unavailable for this session.
							</p>
						))}

					{activePanel === "activity" && (
						<>
							{activityEnabled ? (
								<section className="studio-inspector-section studio-activity-section">
									<div className="studio-inspector-heading">
										<h2>Activity timeline</h2>
										<span>{activityEntries.length}</span>
									</div>
									{activityError ? (
										<p className="studio-inspector-empty">{activityError}</p>
									) : activityLoading && activityEntries.length === 0 ? (
										<p className="studio-inspector-empty">Loading run activity.</p>
									) : activityEntries.length === 0 ? (
										<p className="studio-inspector-empty">Run activity will appear here.</p>
									) : (
										<ol aria-live="polite" className="studio-activity-stream">
											{activityEntries.map(entry => (
												<li key={entry.id}>
													<time>{formatShortTime(entry.occurredAtMs)}</time>
													<span
														aria-hidden="true"
														className={`studio-activity-status studio-activity-status-${entry.status}`}
													/>
													<span>{activityLabel(entry)}</span>
												</li>
											))}
										</ol>
									)}
								</section>
							) : (
								<p className="studio-inspector-empty studio-inspector-start">
									Activity tracking is unavailable for this session.
								</p>
							)}

							{toolCardsEnabled && (
								<section className="studio-inspector-section studio-tool-cards-section">
									<div className="studio-inspector-heading">
										<h2>Tool activity</h2>
										<span>{toolCards.length}</span>
									</div>
									{toolCardsError ? (
										<p className="studio-inspector-empty">{toolCardsError}</p>
									) : toolCardsLoading && toolCards.length === 0 ? (
										<p className="studio-inspector-empty">Loading tool activity.</p>
									) : toolCards.length === 0 ? (
										<p className="studio-inspector-empty">Tool activity will appear here.</p>
									) : (
										<div aria-live="polite" className="studio-tool-card-list">
											{toolCards.map(card => (
												<article
													className={`studio-tool-card studio-tool-card-${card.status}`}
													key={card.id}
												>
													<div>
														<strong>{toolDisplayLabel(card.kind)}</strong>
														<span>{card.status}</span>
													</div>
													<time>{formatShortTime(card.updatedAtMs)}</time>
												</article>
											))}
										</div>
									)}
								</section>
							)}
						</>
					)}
				</>
			)}
		</aside>
	);
});
