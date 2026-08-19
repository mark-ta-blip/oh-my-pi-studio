import { memo } from "react";
import type { StudioSession } from "../../protocol";
import { sessionTitle } from "../presentation";

export type StudioConnectionState = "connecting" | "ready" | "offline";

interface StudioTitlebarProps {
	connection: StudioConnectionState;
	onOpenContext(): void;
	onOpenNavigation(): void;
	onOpenSetup(): void;
	profile: string;
	selectedSession?: StudioSession;
}

export const StudioTitlebar = memo(function StudioTitlebar({
	connection,
	onOpenContext,
	onOpenNavigation,
	onOpenSetup,
	profile,
	selectedSession,
}: StudioTitlebarProps): React.ReactNode {
	return (
		<header className="studio-titlebar">
			<a aria-label="OMP Studio home" className="studio-mark" href="/">
				<span className="studio-mark-kicker">OMP</span>
				<span>Studio</span>
			</a>
			<div className="studio-titlebar-context">
				<span>{selectedSession ? sessionTitle(selectedSession) : "Local workspace"}</span>
				<span className="studio-titlebar-profile">{profile}</span>
			</div>
			<div className="studio-titlebar-actions">
				<button className="studio-titlebar-mobile-button" onClick={onOpenNavigation} type="button">
					Sessions
				</button>
				<button className="studio-titlebar-context-button" onClick={onOpenContext} type="button">
					Context
				</button>
				<div className={`studio-connection studio-connection-${connection}`}>
					<span className="studio-connection-dot" />
					{connection === "ready" ? "connected" : connection === "offline" ? "reconnecting" : "connecting"}
				</div>
				<button className="studio-titlebar-button" onClick={onOpenSetup} type="button">
					Setup
				</button>
			</div>
		</header>
	);
});
