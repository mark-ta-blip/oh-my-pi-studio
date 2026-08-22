import type { StudioFeatures } from "../protocol";
import type { StudioContextPanel } from "./context-panel";

/**
 * A per-session REST snapshot the inspector can ask for.
 *
 * The transcript is deliberately absent: the conversation is the primary reading
 * surface and is hydrated whenever a session is selected, regardless of which
 * inspector panel is open.
 */
export type StudioInspectorResource =
	| "activity"
	| "approvals"
	| "changeSet"
	| "plan"
	| "runHistory"
	| "subagents"
	| "toolDisplays"
	| "usageHistory";

/** Each panel's resources, paired with the bootstrap feature that must be enabled to fetch them. */
const STUDIO_PANEL_RESOURCES: Record<
	StudioContextPanel,
	readonly (readonly [StudioInspectorResource, keyof StudioFeatures])[]
> = {
	overview: [
		["approvals", "approvalControls"],
		["plan", "planSummary"],
		["subagents", "subagentVisibility"],
	],
	activity: [
		["activity", "activityTimeline"],
		["toolDisplays", "toolCards"],
	],
	changes: [["changeSet", "changeReview"]],
	history: [
		["runHistory", "runHistory"],
		["usageHistory", "usageHistory"],
	],
};

const NO_STUDIO_INSPECTOR_DEMAND: ReadonlySet<StudioInspectorResource> = new Set();

/**
 * Resolve which inspector snapshots are worth fetching right now.
 *
 * Selecting a session used to hydrate every inspector resource at once, so a
 * user who never opened the inspector still paid for six REST round trips per
 * session — including the change set, which shells out to Git on the server.
 * Demand is scoped to the visible panel and filtered by advertised features, so
 * a host without a capability is never asked for it.
 */
export function studioInspectorDemand(
	open: boolean,
	panel: StudioContextPanel,
	features: Partial<StudioFeatures>,
): ReadonlySet<StudioInspectorResource> {
	if (!open) return NO_STUDIO_INSPECTOR_DEMAND;
	const demand = new Set<StudioInspectorResource>();
	for (const [resource, feature] of STUDIO_PANEL_RESOURCES[panel]) {
		if (features[feature]) demand.add(resource);
	}
	return demand;
}
