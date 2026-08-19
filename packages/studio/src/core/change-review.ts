import type { StudioChangeSet } from "../protocol";

/** Server-only input resolved from a registered Studio workspace. */
export interface StudioChangeReviewRequest {
	signal?: AbortSignal;
	workspacePath: string;
}

/**
 * Implemented by the coding-agent host. Studio deliberately receives only a
 * projected change set and never imports or spawns Git itself.
 */
export interface StudioChangeReviewAdapter {
	getChangeSet(request: StudioChangeReviewRequest): Promise<StudioChangeSet>;
}

export type StudioChangeReviewErrorCode = "not_repository" | "unavailable";

/** A stable, browser-safe change review failure. */
export class StudioChangeReviewError extends Error {
	constructor(
		readonly code: StudioChangeReviewErrorCode,
		message: string,
	) {
		super(message);
		this.name = "StudioChangeReviewError";
	}
}
