import { useEffect, useMemo, useState } from "react";
import type { StudioActivityEntry, StudioRun, StudioUsageHistoryEntry } from "../../protocol";
import { activityLabel, formatCost, formatCount, formatShortTime } from "../presentation";

const RUN_STATUS_LABELS: Record<StudioRun["status"], string> = {
	cancelled: "Cancelled",
	cancelling: "Stopping",
	completed: "Completed",
	failed: "Failed",
	interrupted: "Interrupted",
	running: "Running",
	starting: "Starting",
};

function runTimestamp(run: StudioRun): number {
	return run.endedAtMs ?? run.startedAtMs;
}

interface StudioRunHistoryProps {
	activityEntries: StudioActivityEntry[];
	enabled: boolean;
	error: string | null;
	loading: boolean;
	onRefresh(): void;
	runs: StudioRun[];
	usageEntries: StudioUsageHistoryEntry[];
}

/** Durable session history rendered from browser-safe run, activity, and usage records. */
export function StudioRunHistory({
	activityEntries,
	enabled,
	error,
	loading,
	onRefresh,
	runs,
	usageEntries,
}: StudioRunHistoryProps): React.ReactNode {
	const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

	useEffect(() => {
		setSelectedRunId(current => (current && runs.some(run => run.id === current) ? current : (runs[0]?.id ?? null)));
	}, [runs]);

	const selectedRun = useMemo(() => runs.find(run => run.id === selectedRunId), [runs, selectedRunId]);
	const selectedActivity = useMemo(
		() => activityEntries.filter(entry => entry.runId === selectedRun?.id).slice(0, 12),
		[activityEntries, selectedRun?.id],
	);
	const selectedUsage = useMemo(
		() => usageEntries.find(entry => entry.runId === selectedRun?.id)?.usage,
		[selectedRun?.id, usageEntries],
	);

	if (!enabled) return null;

	return (
		<section className="studio-inspector-section studio-run-history-section">
			<div className="studio-inspector-heading">
				<h2>History</h2>
				<div className="studio-run-history-actions">
					<span>{runs.length} runs</span>
					<button aria-label="Refresh session history" disabled={loading} onClick={onRefresh} type="button">
						Refresh
					</button>
				</div>
			</div>

			{error ? (
				<p className="studio-inspector-empty">{error}</p>
			) : loading && runs.length === 0 ? (
				<p className="studio-inspector-empty">Loading session history.</p>
			) : runs.length === 0 ? (
				<p className="studio-inspector-empty">Runs will appear here after the first instruction.</p>
			) : (
				<div className="studio-run-history-content">
					<div className="studio-run-history-list" role="list">
						{runs.map(run => (
							<button
								aria-pressed={selectedRun?.id === run.id}
								className={
									selectedRun?.id === run.id
										? "studio-run-history-row studio-run-history-row-selected"
										: "studio-run-history-row"
								}
								key={run.id}
								onClick={() => setSelectedRunId(run.id)}
								type="button"
							>
								<span>{RUN_STATUS_LABELS[run.status]}</span>
								<time dateTime={new Date(runTimestamp(run)).toISOString()}>
									{formatShortTime(runTimestamp(run))}
								</time>
							</button>
						))}
					</div>

					{selectedRun && (
						<div className="studio-run-history-detail">
							<div className="studio-run-history-detail-header">
								<strong>{RUN_STATUS_LABELS[selectedRun.status]}</strong>
								<span>{selectedRun.endedAtMs ? "Finished" : "Active"}</span>
							</div>
							{selectedRun.status === "interrupted" && (
								<p className="studio-recovery-notice">
									This run was interrupted. Review its timeline before continuing.
								</p>
							)}
							{selectedUsage && (
								<dl className="studio-run-history-usage">
									<div>
										<dt>Tokens</dt>
										<dd>{formatCount(selectedUsage.totalTokens)}</dd>
									</div>
									<div>
										<dt>Tools</dt>
										<dd>{formatCount(selectedUsage.toolCalls)}</dd>
									</div>
									<div>
										<dt>Cost</dt>
										<dd>${formatCost(selectedUsage.cost)}</dd>
									</div>
								</dl>
							)}
							{selectedActivity.length > 0 && (
								<ol className="studio-run-history-activity">
									{selectedActivity.map(entry => (
										<li key={entry.id}>
											<time>{formatShortTime(entry.occurredAtMs)}</time>
											<span>{activityLabel(entry)}</span>
										</li>
									))}
								</ol>
							)}
						</div>
					)}
				</div>
			)}
		</section>
	);
}
