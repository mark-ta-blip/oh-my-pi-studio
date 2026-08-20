import { Menu, PanelRight, Settings } from "lucide-react";
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
				<button
					aria-label="Open session navigation"
					className="studio-titlebar-mobile-button studio-icon-button"
					onClick={onOpenNavigation}
					title="Sessions"
					type="button"
				>
					<Menu aria-hidden="true" size={17} strokeWidth={1.8} />
				</button>
				<button
					aria-label="Open session context"
					className="studio-titlebar-context-button studio-icon-button"
					onClick={onOpenContext}
					title="Session context"
					type="button"
				>
					<PanelRight aria-hidden="true" size={17} strokeWidth={1.8} />
				</button>
				<div className={`studio-connection studio-connection-${connection}`}>
					<span className="studio-connection-dot" />
					{connection === "ready" ? "connected" : connection === "offline" ? "reconnecting" : "connecting"}
				</div>
				<button
					aria-label="Open setup"
					className="studio-titlebar-button studio-icon-button"
					onClick={onOpenSetup}
					title="Setup"
					type="button"
				>
					<Settings aria-hidden="true" size={17} strokeWidth={1.8} />
				</button>
			</div>
		</header>
	);
});
