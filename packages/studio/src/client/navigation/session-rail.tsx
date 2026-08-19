import { useMemo, useState } from "react";
import type { StudioSession, StudioWorkspace } from "../../protocol";
import { formatWorkspaceDate, sessionTitle } from "../presentation";

interface StudioSessionRailProps {
	controlPendingId: string | null;
	leaseExpiresAtMs: Record<string, number>;
	onAcquireControl(studioSessionId: string): void;
	onAddProject(): void;
	onOpenSetup(): void;
	onSelectSession(studioSessionId: string): void;
	onSelectWorkspace(workspaceId: string): void;
	selectedSessionId: string | null;
	sessionWorkspaceId: string;
	sessions: StudioSession[];
	workspaces: StudioWorkspace[];
}

export function StudioSessionRail({
	controlPendingId,
	leaseExpiresAtMs,
	onAcquireControl,
	onAddProject,
	onOpenSetup,
	onSelectSession,
	onSelectWorkspace,
	selectedSessionId,
	sessionWorkspaceId,
	sessions,
	workspaces,
}: StudioSessionRailProps): React.ReactNode {
	const [sessionQuery, setSessionQuery] = useState("");
	const visibleSessions = useMemo(() => {
		const query = sessionQuery.trim().toLocaleLowerCase();
		if (!query) return sessions;
		const workspaceLabels = new Map(workspaces.map(workspace => [workspace.id, workspace.label.toLocaleLowerCase()]));
		return sessions.filter(session => {
			const searchable = [
				sessionTitle(session),
				session.model?.id ?? "",
				session.model?.provider ?? "",
				workspaceLabels.get(session.workspaceId) ?? "",
			]
				.join(" ")
				.toLocaleLowerCase();
			return searchable.includes(query);
		});
	}, [sessionQuery, sessions, workspaces]);

	return (
		<aside aria-label="Projects and sessions" className="studio-sidebar">
			<div className="studio-sidebar-actions">
				<button className="studio-new-session" onClick={onOpenSetup} type="button">
					+ New session
				</button>
				<button className="studio-sidebar-button" onClick={onOpenSetup} type="button">
					Settings
				</button>
			</div>
			<label className="studio-session-search">
				<span className="studio-sr-only">Search sessions</span>
				<input
					autoComplete="off"
					onChange={event => setSessionQuery(event.target.value)}
					placeholder="Search sessions"
					type="search"
					value={sessionQuery}
				/>
			</label>

			<section aria-labelledby="studio-projects-heading" className="studio-sidebar-section">
				<div className="studio-sidebar-heading">
					<h2 id="studio-projects-heading">Projects</h2>
					<button aria-label="Add project" onClick={onAddProject} type="button">
						+
					</button>
				</div>
				<div className="studio-project-list">
					{workspaces.length === 0 ? (
						<p className="studio-sidebar-empty">No project folder yet.</p>
					) : (
						workspaces.map(workspace => (
							<button
								className={
									workspace.id === sessionWorkspaceId
										? "studio-project-row studio-project-row-selected"
										: "studio-project-row"
								}
								key={workspace.id}
								onClick={() => onSelectWorkspace(workspace.id)}
								type="button"
							>
								<span>{workspace.label}</span>
								<small>{formatWorkspaceDate(workspace.updatedAtMs)}</small>
							</button>
						))
					)}
				</div>
			</section>

			<section aria-labelledby="studio-sessions-heading" className="studio-sidebar-section studio-sidebar-sessions">
				<div className="studio-sidebar-heading">
					<h2 id="studio-sessions-heading">Sessions</h2>
					<span>
						{visibleSessions.length === sessions.length
							? sessions.length
							: `${visibleSessions.length}/${sessions.length}`}
					</span>
				</div>
				<div className="studio-session-list">
					{sessions.length === 0 ? (
						<p className="studio-sidebar-empty">Start a session to begin a conversation.</p>
					) : visibleSessions.length === 0 ? (
						<p className="studio-sidebar-empty">No sessions match this search.</p>
					) : (
						visibleSessions.map(session => {
							const hasLease = (leaseExpiresAtMs[session.id] ?? 0) > Date.now();
							return (
								<article
									className={
										session.id === selectedSessionId
											? "studio-session-row studio-session-row-selected"
											: "studio-session-row"
									}
									key={session.id}
								>
									<button
										className="studio-session-select"
										onClick={() => onSelectSession(session.id)}
										type="button"
									>
										<span className="studio-session-name">{sessionTitle(session)}</span>
										<span className="studio-session-meta">
											{session.model ? session.model.id : "model unavailable"}
										</span>
									</button>
									<button
										aria-label={
											hasLease
												? `Renew control for ${sessionTitle(session)}`
												: `Take control of ${sessionTitle(session)}`
										}
										className={
											hasLease
												? "studio-session-control studio-session-control-active"
												: "studio-session-control"
										}
										disabled={controlPendingId !== null}
										onClick={() => onAcquireControl(session.id)}
										type="button"
									>
										{controlPendingId === session.id ? "..." : hasLease ? "Control" : "Take"}
									</button>
								</article>
							);
						})
					)}
				</div>
			</section>

			<div className="studio-sidebar-footer">
				<span>OMP Studio</span>
				<span>Local only</span>
			</div>
		</aside>
	);
}
