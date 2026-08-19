import { type StudioServer, startStudioServer } from "@oh-my-pi/omp-studio";
import { openPath } from "../utils/open";
import { createStudioAuthBridge } from "./studio-auth-bridge";
import { createStudioChangeReviewAdapter } from "./studio-change-review";
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

	try {
		studio = await startStudioServer({
			authBridge,
			changeReviewAdapter: createStudioChangeReviewAdapter(),
			dbPath: process.env.OMP_STUDIO_DESKTOP_SMOKE === "1" ? ":memory:" : undefined,
			port: command.port,
			rpcTransportFactory: createStudioRpcTransportFactory(),
		});
		process.stdout.write(`OMP Studio available at: ${studio.url}\n`);
		if (command.open) openPath(studio.url);
		process.stdout.write("Press Ctrl+C to stop\n");

		process.once("SIGINT", handleSignal);
		process.once("SIGTERM", handleSignal);
		await stopped;
	} finally {
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
		if (studio) {
			studio.stop();
		} else {
			authBridge.close();
		}
	}
}
