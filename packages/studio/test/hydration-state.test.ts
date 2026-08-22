import { describe, expect, it } from "bun:test";
import { TranscriptRequestOwnership, UsageHistoryRefreshScheduler } from "../src/client/hydration-state";

describe("selected transcript ownership", () => {
	it("aborts A when B becomes selected and rejects stale ownership", () => {
		const ownership = new TranscriptRequestOwnership();
		const a = ownership.begin("A");
		const b = ownership.begin("B");
		expect(a.controller.signal.aborted).toBe(true);
		expect(ownership.isCurrent(a)).toBe(false);
		expect(ownership.isCurrent(b)).toBe(true);
	});

	it("resync-style abort leaves no owner able to commit", () => {
		const ownership = new TranscriptRequestOwnership();
		const request = ownership.begin("A");
		ownership.abort();
		expect(request.controller.signal.aborted).toBe(true);
		expect(ownership.isCurrent(request)).toBe(false);
	});
});

describe("usage history refresh coalescing", () => {
	it("coalesces visible usage updates and follows up once after an in-flight update", async () => {
		let callback: (() => void) | undefined;
		let resolveFirst: (() => void) | undefined;
		let calls = 0;
		const scheduler = new UsageHistoryRefreshScheduler({
			delayMs: 1,
			isVisible: () => true,
			refresh: async () => {
				calls += 1;
				if (calls === 1) await new Promise<void>(resolve => (resolveFirst = resolve));
			},
			setTimeout: next => {
				callback = next;
				return 1 as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout: () => undefined,
		});
		scheduler.schedule("A", "usage");
		scheduler.schedule("A", "usage");
		expect(callback).toBeDefined();
		callback?.();
		expect(calls).toBe(1);
		scheduler.schedule("A", "usage");
		resolveFirst?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(2);
	});

	it("does not schedule hidden history but terminal state starts immediately when visible", () => {
		let calls = 0;
		const hidden = new UsageHistoryRefreshScheduler({
			delayMs: 1,
			isVisible: () => false,
			refresh: async () => {
				calls += 1;
			},
			setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: () => undefined,
		});
		hidden.schedule("A", "usage");
		expect(calls).toBe(0);
		const visible = new UsageHistoryRefreshScheduler({
			delayMs: 1,
			isVisible: () => true,
			refresh: async () => {
				calls += 1;
			},
			setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
			clearTimeout: () => undefined,
		});
		visible.schedule("A", "terminal");
		expect(calls).toBe(1);
	});
});
