/** One in-flight conversation snapshot request, owned by the session it was started for. */
export interface StudioTranscriptRequest {
	readonly controller: AbortController;
	readonly studioSessionId: string;
}

/**
 * Single-owner guard for the selected conversation's REST snapshot.
 *
 * Only one transcript load matters at a time: the one for the session currently
 * on screen. Superseding it has to both cancel the request and revoke the old
 * owner's right to commit, otherwise a slow response for the previous session
 * lands in the newly selected conversation.
 */
export class TranscriptRequestOwnership {
	#current: StudioTranscriptRequest | undefined;

	/** Take ownership for a session, aborting whichever request held it before. */
	begin(studioSessionId: string): StudioTranscriptRequest {
		this.abort();
		const request: StudioTranscriptRequest = { controller: new AbortController(), studioSessionId };
		this.#current = request;
		return request;
	}

	/** True only for the live owner. A superseded or aborted request must not write state. */
	isCurrent(request: StudioTranscriptRequest): boolean {
		return this.#current === request && !request.controller.signal.aborted;
	}

	/**
	 * Abort the in-flight request and leave no owner behind. Used when the whole
	 * transcript is about to be replaced — a resync — so no request that started
	 * before the reset can commit after it.
	 */
	abort(): void {
		this.#current?.controller.abort();
		this.#current = undefined;
	}

	/** The live owner, for callers that need to read the generation without taking it. */
	get current(): StudioTranscriptRequest | undefined {
		return this.#current;
	}
}

/** Why a usage-history refresh was requested. A terminal run skips the debounce. */
export type StudioUsageHistoryRefreshReason = "usage" | "terminal";

export interface UsageHistoryRefreshOptions {
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
	delayMs: number;
	/** Whether the history panel is on screen. Hidden panels are not fetched at all. */
	isVisible(): boolean;
	refresh(studioSessionId: string): Promise<void>;
	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
}

/**
 * Coalesce usage-history refreshes behind the history panel.
 *
 * `usage.updated` arrives on every provider response, and each one used to fire
 * its own REST fetch whether or not the panel was open. Requests are debounced
 * while streaming, dropped entirely when the panel is hidden, and never
 * overlapped: a refresh requested during an in-flight one is collapsed into a
 * single follow-up so the panel still lands on the newest totals.
 *
 * Timers are injected so the coalescing contract is testable without real time.
 * The scheduler has no visibility subscription of its own — the caller schedules
 * again when the panel opens.
 */
export class UsageHistoryRefreshScheduler {
	#followUp: string | undefined;
	#inFlight = false;
	#options: UsageHistoryRefreshOptions;
	#pending: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: UsageHistoryRefreshOptions) {
		this.#options = options;
	}

	schedule(studioSessionId: string, reason: StudioUsageHistoryRefreshReason): void {
		if (!this.#options.isVisible()) return;
		if (this.#inFlight) {
			this.#followUp = studioSessionId;
			return;
		}
		// A run that just ended has final totals, so waiting out the debounce only
		// delays the number the user is looking for.
		if (reason === "terminal") {
			this.#clearTimer();
			void this.#run(studioSessionId);
			return;
		}
		this.#pending = studioSessionId;
		if (this.#timer !== undefined) return;
		this.#timer = this.#options.setTimeout(() => {
			this.#timer = undefined;
			const next = this.#pending;
			this.#pending = undefined;
			if (next !== undefined) void this.#run(next);
		}, this.#options.delayMs);
	}

	/** Drop scheduled and follow-up work. Used when the session or panel goes away. */
	cancel(): void {
		this.#clearTimer();
		this.#followUp = undefined;
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		this.#options.clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending = undefined;
	}

	async #run(studioSessionId: string): Promise<void> {
		this.#inFlight = true;
		try {
			await this.#options.refresh(studioSessionId);
		} catch {
			// The caller owns error surfacing; a failed refresh must not stall the next one.
		} finally {
			this.#inFlight = false;
		}
		const followUp = this.#followUp;
		this.#followUp = undefined;
		if (followUp !== undefined) await this.#run(followUp);
	}
}
