import { type StudioServer, startStudioServer } from "@oh-my-pi/omp-studio";
import { openPath } from "../utils/open";
import { createStudioAuthBridge } from "./studio-auth-bridge";
import { createStudioChangeReviewAdapter } from "./studio-change-review";
import {
	isStudioDesktopControlChannelEnabled,
	STUDIO_DESKTOP_CONTROL_CHANNEL_NOTICE,
	watchStudioDesktopControlChannel,
} from "./studio-control-channel";
import { createStudioRpcTransportFactory } from "./studio-rpc-transport";

export interface StudioCommandArgs {
	port: number;
	open: boolean;
}

/** Start the local Studio server and keep the command alive until it receives a shutdown signal. */
export async function runStudioCommand(command: StudioCommandArgs): Promise<void> {
	const authBridge = await createStudioAuthBridge();
	let studio: StudioServer | undefined;
	const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
	const handleSignal = (): void => stop();
	let disposeControlChannel: (() => void) | undefined;

	try {
		studio = await startStudioServer({
			authBridge,
			changeReviewAdapter: createStudioChangeReviewAdapter(),
			dbPath: process.env.OMP_STUDIO_DESKTOP_SMOKE === "1" ? ":memory:" : undefined,
			port: command.port,
			rpcTransportFactory: createStudioRpcTransportFactory(),
		});
		process.once("SIGINT", handleSignal);
		process.once("SIGTERM", handleSignal);
		// The desktop shell cannot signal this process on Windows, so it owns this
		// process's lifetime through stdin instead. Install the channel before
		// announcing it, then announce it before the ready line: the shell reads
		// stdout only until it sees the ready line.
		if (isStudioDesktopControlChannelEnabled(process.env, process.stdin.isTTY)) {
			disposeControlChannel = watchStudioDesktopControlChannel({ input: process.stdin, stop: () => stop() });
			process.stdout.write(`${STUDIO_DESKTOP_CONTROL_CHANNEL_NOTICE}\n`);
		}
		process.stdout.write(`OMP Studio available at: ${studio.url}\n`);
		if (command.open) openPath(studio.url);
		process.stdout.write("Press Ctrl+C to stop\n");

		await stopped;
	} finally {
		disposeControlChannel?.();
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
		if (studio) {
			studio.stop();
		} else {
			authBridge.close();
		}
	}
}
