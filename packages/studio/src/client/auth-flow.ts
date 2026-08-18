import type { StudioAuthProgress } from "../protocol";

/**
 * Auth updates are incremental: a later progress event usually omits the
 * authorization URL emitted by the preceding authorization event.
 */
export function mergeStudioAuthProgress(
	current: StudioAuthProgress | null,
	next: StudioAuthProgress,
): StudioAuthProgress {
	if (!current || current.flowId !== next.flowId) return next;
	const authorizationUrl = next.authorizationUrl ?? current.authorizationUrl;
	const launchUrl = next.launchUrl ?? current.launchUrl;
	const instructions = next.instructions ?? current.instructions;
	return {
		...next,
		...(authorizationUrl ? { authorizationUrl } : {}),
		...(launchUrl ? { launchUrl } : {}),
		...(instructions ? { instructions } : {}),
	};
}
