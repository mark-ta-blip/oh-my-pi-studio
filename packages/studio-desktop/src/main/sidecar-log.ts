import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

/** Reset the log once it passes this size so a crash loop cannot fill the disk. */
const SIDECAR_LOG_MAX_BYTES = 1_048_576;

/**
 * Append-only sink for sidecar stderr. Startup failures are otherwise invisible:
 * the Electron main process has no console the user can read, so the same lines
 * go to a file under userData and into a bounded in-memory tail for the error
 * dialog.
 */
export interface StudioSidecarLogSink {
	/** Absolute log path, or undefined when the log could not be opened. */
	path: string | undefined;
	write(line: string): void;
	close(): Promise<void>;
}

const NULL_LOG_SINK: StudioSidecarLogSink = {
	path: undefined,
	write: () => undefined,
	close: async () => undefined,
};

/**
 * Open the sidecar stderr log, rotating it first when it has grown past the cap.
 * A sink is best-effort: an unwritable userData directory must degrade to an
 * in-memory tail rather than block startup.
 */
export async function openSidecarLogSink(logPath: string): Promise<StudioSidecarLogSink> {
	let stream: fs.WriteStream;
	try {
		await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
		const existing = await fsPromises.stat(logPath).catch(() => undefined);
		stream = fs.createWriteStream(logPath, { flags: existing && existing.size > SIDECAR_LOG_MAX_BYTES ? "w" : "a" });
	} catch {
		return NULL_LOG_SINK;
	}

	let writable = true;
	// An EPIPE/ENOSPC on the log must not take down the app with an unhandled
	// 'error' event, so drop the sink and keep the in-memory tail.
	stream.on("error", () => {
		writable = false;
	});

	return {
		path: logPath,
		write(line: string): void {
			if (!writable) return;
			try {
				stream.write(line);
			} catch {
				writable = false;
			}
		},
		async close(): Promise<void> {
			writable = false;
			await new Promise<void>(resolve => stream.close(() => resolve()));
		},
	};
}
