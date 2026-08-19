import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { type DesktopPaths, resolveDevelopmentServerScript } from "./paths";
import { openSidecarLogSink, type StudioSidecarLogSink } from "./sidecar-log";

const READY_LINE = /^OMP Studio available at: (https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)$/;
const STUDIO_SERVER_READY_TIMEOUT_MS = 30_000;
const STUDIO_SERVER_STOP_GRACE_MS = 2_000;
const STUDIO_BOOTSTRAP_API_VERSION = 1;
/** Enough stderr to identify a startup failure without pasting a whole log into a dialog. */
const STUDIO_SERVER_STDERR_TAIL_LINES = 20;
const STUDIO_SERVER_STDERR_LINE_LIMIT = 400;
/** How long an exited sidecar's stderr may still be in flight. See {@link drainSidecarStderr}. */
const STUDIO_SERVER_STDERR_DRAIN_MS = 500;

export interface StudioServerProcess {
	url: string;
	stop(): Promise<void>;
}

/** A sidecar that never became ready, carrying the diagnostics needed to explain why. */
export class StudioSidecarStartupError extends Error {
	constructor(
		message: string,
		/** Last sidecar stderr lines, oldest first. */
		readonly stderrTail: readonly string[],
		readonly logPath: string | undefined,
	) {
		super(message);
		this.name = "StudioSidecarStartupError";
	}
}

export interface StudioServerLaunchOptions {
	paths: DesktopPaths;
	packaged: boolean;
	/** Development-only explicit OMP executable. Packaged apps always use their bundled sidecar. */
	command?: string;
	readyTimeoutMs?: number;
	signal?: AbortSignal;
	smoke?: boolean;
}

export interface StudioSidecarSupervisionOptions {
	readyTimeoutMs?: number;
	signal?: AbortSignal;
	logSink?: StudioSidecarLogSink;
}

type StudioSidecar = childProcess.ChildProcessByStdio<null, Readable, Readable>;

function serverExecutable(paths: DesktopPaths): string {
	return path.join(paths.serverResourceDir, process.platform === "win32" ? "omp.exe" : "omp");
}

function studioServerEnvironment(options: StudioServerLaunchOptions): NodeJS.ProcessEnv {
	return {
		...process.env,
		OMP_STUDIO_DESKTOP: "1",
		...(options.smoke ? { OMP_STUDIO_DESKTOP_SMOKE: "1" } : {}),
	};
}

function spawnServer(options: StudioServerLaunchOptions): StudioSidecar {
	const configuredCommand = options.packaged ? undefined : options.command;
	if (configuredCommand) {
		return childProcess.spawn(configuredCommand, ["studio", "--no-open", "--port", "0"], {
			cwd: options.paths.packageRoot,
			env: studioServerEnvironment(options),
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	if (options.packaged) {
		return childProcess.spawn(serverExecutable(options.paths), ["studio", "--no-open", "--port", "0"], {
			cwd: options.paths.userDataDir,
			env: studioServerEnvironment(options),
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	return childProcess.spawn(
		"bun",
		[resolveDevelopmentServerScript(options.paths.packageRoot), "studio", "--no-open", "--port", "0"],
		{
			cwd: options.paths.packageRoot,
			env: studioServerEnvironment(options),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
}

function isStudioBootstrap(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const payload = value as Record<string, unknown>;
	return payload.apiVersion === STUDIO_BOOTSTRAP_API_VERSION && payload.mode === "local-single-user";
}

/** Validate the one-time local access exchange exposed by a supervised sidecar. */
export async function verifyStudioSidecarAccess(url: string): Promise<void> {
	let origin: string;
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1") {
			throw new Error("invalid local sidecar URL");
		}
		origin = parsedUrl.origin;
	} catch {
		throw new Error("OMP Studio sidecar returned an invalid local URL.");
	}

	const exchange = await fetch(url, { redirect: "manual" });
	if (exchange.status !== 302) {
		throw new Error(`OMP Studio sidecar token exchange failed: HTTP ${exchange.status}`);
	}
	const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie?.startsWith("omp_studio_session=")) {
		throw new Error("OMP Studio sidecar token exchange did not issue a session cookie.");
	}

	const bootstrap = await fetch(`${origin}/api/v1/bootstrap`, { headers: { Cookie: cookie } });
	if (!bootstrap.ok) {
		throw new Error(`OMP Studio sidecar bootstrap failed: HTTP ${bootstrap.status}`);
	}
	let payload: unknown;
	try {
		payload = await bootstrap.json();
	} catch {
		throw new Error("OMP Studio sidecar bootstrap returned invalid JSON.");
	}
	if (!isStudioBootstrap(payload)) {
		throw new Error("OMP Studio sidecar bootstrap did not match the local Studio contract.");
	}
}

function hasExited(child: StudioSidecar): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

async function waitForSidecarExit(child: StudioSidecar, timeoutMs: number): Promise<boolean> {
	if (hasExited(child)) return true;
	if (timeoutMs <= 0) return false;

	const { promise, resolve } = Promise.withResolvers<boolean>();
	let timer: Timer | undefined;
	let settled = false;
	const cleanup = (): void => {
		if (timer) clearTimeout(timer);
		child.removeListener("exit", onExit);
		child.removeListener("error", onError);
	};
	const finish = (value: boolean): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const onExit = (): void => {
		finish(true);
	};
	const onError = (): void => {
		finish(true);
	};
	child.once("exit", onExit);
	child.once("error", onError);
	timer = setTimeout(() => {
		finish(false);
	}, timeoutMs);
	timer.unref();
	return await promise;
}

async function stopSidecar(child: StudioSidecar): Promise<void> {
	if (hasExited(child)) return;
	try {
		child.kill();
	} catch {
		// The sidecar may have exited between the state check and the signal.
	}
	if (await waitForSidecarExit(child, STUDIO_SERVER_STOP_GRACE_MS)) return;
	try {
		child.kill("SIGKILL");
	} catch {
		// The sidecar may have exited during the grace period.
	}
	await waitForSidecarExit(child, STUDIO_SERVER_STOP_GRACE_MS);
}

/**
 * Wait for stderr to reach end-of-stream before the tail is snapshotted.
 *
 * 'exit' fires when the process is gone, not when its output has been read. In
 * practice the queued 'data' events flush during the first await on the failure
 * path, so the tail is already complete — but nothing in the stream contract
 * promises that, and the lines this drains are the only explanation the startup
 * dialog gets. Bounded, because a stderr that never ends must not hold startup
 * open.
 */
async function drainSidecarStderr(child: StudioSidecar): Promise<void> {
	if (child.stderr.readableEnded) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, STUDIO_SERVER_STDERR_DRAIN_MS);
	timer.unref();
	const finish = (): void => {
		clearTimeout(timer);
		resolve();
	};
	child.stderr.once("end", finish);
	child.stderr.once("close", finish);
	child.stderr.once("error", finish);
	await promise;
}

export async function startStudioServer(options: StudioServerLaunchOptions): Promise<StudioServerProcess> {
	if (options.signal?.aborted) throw new StudioSidecarStartupError("OMP Studio startup was cancelled.", [], undefined);
	const logSink = await openSidecarLogSink(options.paths.sidecarLogPath);
	let child: StudioSidecar;
	try {
		child = spawnServer(options);
	} catch (error) {
		await logSink.close();
		throw error;
	}
	return await superviseStudioSidecar(child, {
		readyTimeoutMs: options.readyTimeoutMs,
		signal: options.signal,
		logSink,
	});
}

/**
 * Wait for a spawned sidecar's ready line while tailing its stderr.
 *
 * Split out from {@link startStudioServer} so the supervision contract — ready
 * line, timeout, abort, and early exit — is testable without a packaged sidecar.
 */
export async function superviseStudioSidecar(
	child: StudioSidecar,
	options: StudioSidecarSupervisionOptions = {},
): Promise<StudioServerProcess> {
	const logSink = options.logSink;
	const stdoutLines = readline.createInterface({ input: child.stdout });
	const stderrLines = readline.createInterface({ input: child.stderr });
	const stderrTail: string[] = [];
	const { promise: ready, resolve, reject } = Promise.withResolvers<string>();
	let settled = false;
	const readyTimeoutMs = options.readyTimeoutMs ?? STUDIO_SERVER_READY_TIMEOUT_MS;

	// readline also drains stderr, which the sidecar's pipe needs regardless of
	// whether anything is listening.
	stderrLines.on("line", line => {
		logSink?.write(`${line}\n`);
		stderrTail.push(
			line.length > STUDIO_SERVER_STDERR_LINE_LIMIT
				? `${line.slice(0, STUDIO_SERVER_STDERR_LINE_LIMIT - 3)}...`
				: line,
		);
		if (stderrTail.length > STUDIO_SERVER_STDERR_TAIL_LINES) stderrTail.shift();
	});
	stderrLines.on("error", () => undefined);

	const settleError = (error: Error): void => {
		if (settled) return;
		settled = true;
		reject(error);
	};
	const abortStartup = (): void => settleError(new Error("OMP Studio startup was cancelled."));
	if (options.signal) options.signal.addEventListener("abort", abortStartup, { once: true });
	child.once("error", error => settleError(error instanceof Error ? error : new Error(String(error))));
	child.once("exit", (code, signal) => {
		if (!settled) settleError(new Error(`OMP Studio sidecar exited before ready (${code ?? signal ?? "unknown"}).`));
	});
	const readyTimeout = setTimeout(() => {
		settleError(new Error(`Timed out waiting ${readyTimeoutMs / 1000}s for OMP Studio sidecar.`));
	}, readyTimeoutMs);
	readyTimeout.unref();

	void (async () => {
		try {
			for await (const line of stdoutLines) {
				const match = READY_LINE.exec(line.trim());
				if (!match) continue;
				if (settled) continue;
				settled = true;
				resolve(match[1]);
				break;
			}
			if (!settled) settleError(new Error("OMP Studio sidecar closed its output before becoming ready."));
		} catch (error) {
			settleError(error instanceof Error ? error : new Error(String(error)));
		}
	})();

	try {
		const url = await ready;
		return {
			url,
			async stop(): Promise<void> {
				stdoutLines.close();
				await stopSidecar(child);
				stderrLines.close();
				await logSink?.close();
			},
		};
	} catch (error) {
		stdoutLines.close();
		await stopSidecar(child);
		// Snapshot the tail only once stderr has ended: these lines are the whole
		// diagnostic the startup dialog and log have to offer.
		await drainSidecarStderr(child);
		stderrLines.close();
		await logSink?.close();
		if (error instanceof StudioSidecarStartupError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new StudioSidecarStartupError(message, [...stderrTail], logSink?.path);
	} finally {
		clearTimeout(readyTimeout);
		options.signal?.removeEventListener("abort", abortStartup);
	}
}

/** Start, authenticate against, and stop a sidecar without opening an Electron window. */
export async function smokeTestStudioSidecar(options: StudioServerLaunchOptions): Promise<void> {
	const server = await startStudioServer({ ...options, smoke: true });
	try {
		await verifyStudioSidecarAccess(server.url);
	} finally {
		await server.stop();
	}
}
