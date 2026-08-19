import type { StudioPlanSummary } from "../protocol";

/** Keep the newest aggregate when a REST snapshot races a live event. */
export function mergeStudioPlanSummary(
	current: StudioPlanSummary | undefined,
	incoming: StudioPlanSummary | undefined,
): StudioPlanSummary | undefined {
	if (!incoming) return current;
	if (!current || incoming.updatedAtMs >= current.updatedAtMs) return incoming;
	return current;
}
