import * as readline from "node:readline";
import type { Readable } from "node:stream";

/** The only command the desktop shell may send over the control channel. */
export const STUDIO_DESKTOP_SHUTDOWN_COMMAND = "shutdown";

/**
 * Printed on stdout once the channel is listening, before the ready line.
 *
 * A sidecar built before the channel existed prints nothing, so the shell can
 * skip straight to signalling instead of waiting out a graceful grace period that
 * nothing is listening for.
 */
export const STUDIO_DESKTOP_CONTROL_CHANNEL_NOTICE = "OMP Studio control channel: stdin";

/** Why the control channel asked this process to stop. */
export type StudioDesktopControlStopReason = "shutdown" | "channel_closed";

export interface StudioDesktopControlChannelOptions {
	/** This process's stdin, owned by the desktop shell that spawned it. */
	input: Readable;
	stop(reason: StudioDesktopControlStopReason): void;
}

/**
 * Whether this process is a desktop-supervised sidecar whose stdin is a control
 * channel rather than a terminal.
 *
 * A TTY is excluded so a developer running `omp studio` by hand with the desktop
 * environment set does not have their keystrokes consumed.
 */
export function isStudioDesktopControlChannelEnabled(env: NodeJS.ProcessEnv, isTty: boolean | undefined): boolean {
	return env.OMP_STUDIO_DESKTOP === "1" && isTty !== true;
}

/**
 * Let the desktop shell end this process without sending a signal.
 *
 * Windows has no SIGTERM, so a shell that terminates the sidecar has no way to
 * run the Studio teardown first: the RPC children are still attached when the
 * process dies. A line on stdin gives the shell a graceful stop that works the
 * same on every platform.
 *
 * A closed channel means the shell itself is gone. A sidecar with no supervisor
 * must not keep serving, so that ends the process too — which is the one case no
 * amount of care in the shell can cover, because a crashed shell runs no cleanup.
 *
 * Returns a disposer that detaches without triggering the stop it guards.
 */
export function watchStudioDesktopControlChannel(options: StudioDesktopControlChannelOptions): () => void {
	const lines = readline.createInterface({ input: options.input });
	let settled = false;
	const settle = (reason: StudioDesktopControlStopReason): void => {
		if (settled) return;
		settled = true;
		options.stop(reason);
	};

	lines.on("line", line => {
		if (line.trim() === STUDIO_DESKTOP_SHUTDOWN_COMMAND) settle("shutdown");
	});
	lines.on("close", () => settle("channel_closed"));
	lines.on("error", () => settle("channel_closed"));

	return () => {
		// Detach first: closing the interface emits 'close', which would otherwise
		// report a shutdown during normal teardown.
		lines.removeAllListeners();
		lines.close();
	};
}
