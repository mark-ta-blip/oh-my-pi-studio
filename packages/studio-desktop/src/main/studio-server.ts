import * as childProcess from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { type DesktopPaths, resolveDevelopmentServerScript } from "./paths";

const READY_LINE = /^OMP Studio available at: (https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)$/;
const STUDIO_SERVER_READY_TIMEOUT_MS = 30_000;
const STUDIO_SERVER_STOP_GRACE_MS = 2_000;

export interface StudioServerProcess {
	url: string;
	stop(): Promise<void>;
}

export interface StudioServerLaunchOptions {
	paths: DesktopPaths;
	packaged: boolean;
	command?: string;
	readyTimeoutMs?: number;
	signal?: AbortSignal;
}

type StudioSidecar = childProcess.ChildProcessByStdio<null, Readable, Readable>;

function serverExecutable(paths: DesktopPaths): string {
	return path.join(paths.serverResourceDir, process.platform === "win32" ? "omp.exe" : "omp");
}

function spawnServer(options: StudioServerLaunchOptions): StudioSidecar {
	const configuredCommand = options.command ?? process.env.OMP_STUDIO_OMP_EXECUTABLE;
	if (configuredCommand) {
		return childProcess.spawn(configuredCommand, ["studio", "--no-open", "--port", "0"], {
			cwd: options.paths.packageRoot,
			env: { ...process.env, OMP_STUDIO_DESKTOP: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	if (options.packaged) {
		return childProcess.spawn(serverExecutable(options.paths), ["studio", "--no-open", "--port", "0"], {
			cwd: options.paths.userDataDir,
			env: { ...process.env, OMP_STUDIO_DESKTOP: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	return childProcess.spawn(
		"bun",
		[resolveDevelopmentServerScript(options.paths.packageRoot), "studio", "--no-open", "--port", "0"],
		{
			cwd: options.paths.packageRoot,
			env: { ...process.env, OMP_STUDIO_DESKTOP: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
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

export async function startStudioServer(options: StudioServerLaunchOptions): Promise<StudioServerProcess> {
	if (options.signal?.aborted) throw new Error("OMP Studio startup was cancelled.");
	const child = spawnServer(options);
	const lines = readline.createInterface({ input: child.stdout });
	const { promise: ready, resolve, reject } = Promise.withResolvers<string>();
	let settled = false;
	const readyTimeoutMs = options.readyTimeoutMs ?? STUDIO_SERVER_READY_TIMEOUT_MS;

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
	child.stderr.on("data", () => undefined);
	const readyTimeout = setTimeout(() => {
		settleError(new Error(`Timed out waiting ${readyTimeoutMs / 1000}s for OMP Studio sidecar.`));
	}, readyTimeoutMs);
	readyTimeout.unref();

	void (async () => {
		try {
			for await (const line of lines) {
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
				lines.close();
				await stopSidecar(child);
			},
		};
	} catch (error) {
		lines.close();
		await stopSidecar(child);
		throw error;
	} finally {
		clearTimeout(readyTimeout);
		options.signal?.removeEventListener("abort", abortStartup);
	}
}
