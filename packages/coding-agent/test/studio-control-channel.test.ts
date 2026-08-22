import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
	isStudioDesktopControlChannelEnabled,
	watchStudioDesktopControlChannel,
} from "../src/cli/studio-control-channel";

function watchChannel() {
	const input = new PassThrough();
	const reasons: string[] = [];
	const dispose = watchStudioDesktopControlChannel({ input, stop: reason => reasons.push(reason) });
	return { dispose, input, reasons };
}

/** readline delivers lines asynchronously; let the queued events run. */
async function settle(): Promise<void> {
	await Bun.sleep(10);
}

test("stops once when the shell sends the shutdown command", async () => {
	const channel = watchChannel();

	channel.input.write("shutdown\n");
	await settle();

	expect(channel.reasons).toEqual(["shutdown"]);
	channel.dispose();
});

test("ignores anything that is not the shutdown command", async () => {
	const channel = watchChannel();

	channel.input.write("status\nSHUTDOWN NOW\n\n");
	await settle();

	expect(channel.reasons).toEqual([]);
	channel.dispose();
});

test("tolerates surrounding whitespace from the channel", async () => {
	const channel = watchChannel();

	channel.input.write("  shutdown \r\n");
	await settle();

	expect(channel.reasons).toEqual(["shutdown"]);
	channel.dispose();
});

test("stops when the channel closes, because a sidecar with no shell must not keep serving", async () => {
	const channel = watchChannel();

	channel.input.end();
	await settle();

	expect(channel.reasons).toEqual(["channel_closed"]);
});

test("reports the stop only once even if the channel closes afterwards", async () => {
	const channel = watchChannel();

	channel.input.write("shutdown\n");
	await settle();
	channel.input.end();
	await settle();

	expect(channel.reasons).toEqual(["shutdown"]);
});

test("disposing detaches without reporting a stop", async () => {
	const channel = watchChannel();

	channel.dispose();
	channel.input.write("shutdown\n");
	channel.input.end();
	await settle();

	// Normal teardown closes the interface too; that must not look like a request.
	expect(channel.reasons).toEqual([]);
});

test("enables the channel only for a desktop sidecar whose stdin is not a terminal", () => {
	expect(isStudioDesktopControlChannelEnabled({ OMP_STUDIO_DESKTOP: "1" }, false)).toBe(true);
	expect(isStudioDesktopControlChannelEnabled({ OMP_STUDIO_DESKTOP: "1" }, undefined)).toBe(true);
	// A developer running `omp studio` by hand must keep their keystrokes.
	expect(isStudioDesktopControlChannelEnabled({ OMP_STUDIO_DESKTOP: "1" }, true)).toBe(false);
	expect(isStudioDesktopControlChannelEnabled({}, false)).toBe(false);
	expect(isStudioDesktopControlChannelEnabled({ OMP_STUDIO_DESKTOP: "0" }, false)).toBe(false);
	expect(isStudioDesktopControlChannelEnabled({ OMP_STUDIO_DESKTOP: "true" }, false)).toBe(false);
});
