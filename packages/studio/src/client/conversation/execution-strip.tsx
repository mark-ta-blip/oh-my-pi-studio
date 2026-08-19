import type {
	StudioActivityEntry,
	StudioApproval,
	StudioPlanSummary,
	StudioRun,
	StudioToolDisplay,
} from "../../protocol";
import type { StudioContextPanel } from "../context-panel";
import { activityLabel, formatCount } from "../presentation";

interface StudioExecutionStripProps {
	activeRun?: StudioRun;
	activityEntries: StudioActivityEntry[];
	approvals: StudioApproval[];
	plan?: StudioPlanSummary;
	toolCards: StudioToolDisplay[];
	onOpenContext(panel: StudioContextPanel): void;
}

function runLabel(activeRun: StudioRun | undefined): string {
	if (!activeRun) return "Ready for the next instruction";
	if (activeRun.status === "starting") return "Preparing the run";
	if (activeRun.status === "cancelling") return "Stopping the run";
	return "Agent is working";
}

function runStatus(activeRun: StudioRun | undefined): string {
	if (!activeRun) return "idle";
	return activeRun.status;
}

function toolLabel(kind: StudioToolDisplay["kind"]): string {
	switch (kind) {
		case "command":
			return "Command";
		case "file_read":
			return "File read";
		case "file_write":
			return "File update";
		case "file_search":
			return "File search";
		case "web":
			return "Web request";
		case "task":
			return "Task";
		case "tool":
			return "Tool";
	}
}

export function StudioExecutionStrip({
	activeRun,
	activityEntries,
	approvals,
	plan,
	toolCards,
	onOpenContext,
}: StudioExecutionStripProps): React.ReactNode {
	const pendingApprovals = approvals.filter(approval => approval.status === "pending").length;
	const recentActivity = activityEntries.slice(0, 3);
	const recentTools = toolCards.slice(0, 2);
	const completedPlan = plan ? plan.completedTaskCount : 0;
	const totalPlan = plan ? plan.totalTaskCount : 0;
	const planProgress = totalPlan > 0 ? Math.min(100, Math.round((completedPlan / totalPlan) * 100)) : 0;

	return (
		<section aria-label="Current run" className="studio-execution-strip">
			<div className="studio-execution-summary">
				<div className="studio-execution-state">
					<span
						aria-hidden="true"
						className={`studio-execution-pulse studio-execution-pulse-${runStatus(activeRun)}`}
					/>
					<div>
						<span className="studio-section-kicker">Run workspace</span>
						<strong>{runLabel(activeRun)}</strong>
						<span className="studio-execution-subtitle">
							{activeRun ? "Live summaries appear as OMP works." : "The conversation is ready."}
						</span>
					</div>
				</div>
				<div className="studio-execution-metrics">
					<button onClick={() => onOpenContext("activity")} type="button">
						<strong>{formatCount(activityEntries.length)}</strong>
						<span>activity</span>
					</button>
					{plan && (
						<button onClick={() => onOpenContext("overview")} type="button">
							<strong>
								{completedPlan}/{totalPlan}
							</strong>
							<span>plan done</span>
						</button>
					)}
					<button
						className={pendingApprovals > 0 ? "studio-execution-metric-alert" : ""}
						onClick={() => onOpenContext("overview")}
						type="button"
					>
						<strong>{formatCount(pendingApprovals)}</strong>
						<span>decisions</span>
					</button>
				</div>
			</div>

			{plan && totalPlan > 0 && (
				<div aria-label={`Plan progress ${planProgress}%`} className="studio-execution-progress">
					<span style={{ width: `${planProgress}%` }} />
				</div>
			)}

			{(recentActivity.length > 0 || recentTools.length > 0) && (
				<div className="studio-execution-events" aria-live="polite">
					{recentActivity.map(entry => (
						<button
							className="studio-execution-event"
							key={entry.id}
							onClick={() => onOpenContext("activity")}
							type="button"
						>
							<span className={`studio-execution-event-dot studio-execution-event-dot-${entry.status}`} />
							<span>{activityLabel(entry)}</span>
						</button>
					))}
					{recentTools.map(card => (
						<button
							className="studio-execution-event"
							key={card.id}
							onClick={() => onOpenContext("activity")}
							type="button"
						>
							<span className={`studio-execution-event-dot studio-execution-event-dot-${card.status}`} />
							<span>
								{toolLabel(card.kind)} {card.status}
							</span>
						</button>
					))}
				</div>
			)}
		</section>
	);
}
