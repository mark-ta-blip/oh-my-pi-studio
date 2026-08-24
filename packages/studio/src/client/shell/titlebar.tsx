import { Menu, Minimize2, Minus, PanelRight, Settings, Square, X } from "lucide-react";
import { memo } from "react";
import type { StudioSession } from "../../protocol";
import { sessionTitle } from "../presentation";
import { requestStudioWindowControl, type StudioWindowChrome, useStudioWindowChrome } from "./window-chrome";

export type StudioConnectionState = "connecting" | "ready" | "offline";

interface StudioTitlebarProps {
	connection: StudioConnectionState;
	onOpenContext(): void;
	onOpenNavigation(): void;
	onOpenSetup(): void;
	profile: string;
	selectedSession?: StudioSession;
}

/**
 * Ignore a double-click that landed on a control rather than the drag region.
 *
 * React events bubble, so a double-click on the settings button would otherwise
 * maximize the window as well as opening setup.
 */
function isDragSurface(target: EventTarget | null): boolean {
	return !(target instanceof Element) || target.closest("a, button, input, select, textarea") === null;
}

/** The three caption buttons, rendered only where the OS draws none. */
function StudioWindowControls({ chrome }: { chrome: StudioWindowChrome }): React.ReactNode {
	const RestoreIcon = chrome.maximized ? Minimize2 : Square;
	return (
		<div className="studio-window-controls">
			<button
				aria-label="Minimize window"
				className="studio-window-control"
				onClick={() => requestStudioWindowControl("minimize")}
				title="Minimize"
				type="button"
			>
				<Minus aria-hidden="true" size={15} strokeWidth={1.8} />
			</button>
			<button
				aria-label={chrome.maximized ? "Restore window" : "Maximize window"}
				className="studio-window-control"
				onClick={() => requestStudioWindowControl("toggle-maximize")}
				title={chrome.maximized ? "Restore" : "Maximize"}
				type="button"
			>
				<RestoreIcon aria-hidden="true" size={13} strokeWidth={1.8} />
			</button>
			<button
				aria-label="Close window"
				className="studio-window-control studio-window-control-close"
				onClick={() => requestStudioWindowControl("close")}
				title="Close"
				type="button"
			>
				<X aria-hidden="true" size={15} strokeWidth={1.8} />
			</button>
		</div>
	);
}

export const StudioTitlebar = memo(function StudioTitlebar({
	connection,
	onOpenContext,
	onOpenNavigation,
	onOpenSetup,
	profile,
	selectedSession,
}: StudioTitlebarProps): React.ReactNode {
	const chrome = useStudioWindowChrome();
	// In a browser this stays exactly `studio-titlebar`; every chrome behaviour below
	// hangs off classes that only the desktop shell ever gets.
	const className = [
		"studio-titlebar",
		chrome ? "studio-titlebar-chrome" : undefined,
		chrome ? `studio-titlebar-${chrome.platform}` : undefined,
		chrome?.maximized ? "studio-titlebar-maximized" : undefined,
	]
		.filter(part => part !== undefined)
		.join(" ");
	return (
		<header
			className={className}
			// Windows and macOS keep their native caption buttons, which brings
			// double-click-to-maximize with them. A plainly frameless window has
			// neither, so the gesture is reproduced here.
			onDoubleClick={
				chrome?.controlsInWindow
					? event => {
							if (isDragSurface(event.target)) requestStudioWindowControl("toggle-maximize");
						}
					: undefined
			}
		>
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
				{chrome?.controlsInWindow ? <StudioWindowControls chrome={chrome} /> : null}
			</div>
		</header>
	);
});
