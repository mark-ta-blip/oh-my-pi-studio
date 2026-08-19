export type StudioContextPanel = "overview" | "activity" | "changes" | "history";

export const STUDIO_CONTEXT_PANELS: readonly StudioContextPanel[] = ["overview", "activity", "changes", "history"];

export function studioContextPanelLabel(panel: StudioContextPanel): string {
	switch (panel) {
		case "overview":
			return "Overview";
		case "activity":
			return "Activity";
		case "changes":
			return "Changes";
		case "history":
			return "History";
	}
}
