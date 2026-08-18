import * as childProcess from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { type DesktopPaths, resolveDevelopmentServerScript } from "./paths";

const READY_LINE = /^OMP Studio available at: (https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)$/;

export interface StudioServerProcess {
	url: string;
	stop(): Promise<void>;
}

export interface StudioServerLaunchOptions {
	paths: DesktopPaths;
	packaged: boolean;
	command?: string;
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

export async function startStudioServer(options: StudioServerLaunchOptions): Promise<StudioServerProcess> {
	const child = spawnServer(options);
	const lines = readline.createInterface({ input: child.stdout });
	const { promise: ready, resolve, reject } = Promise.withResolvers<string>();
	let settled = false;

	const settleError = (error: Error): void => {
		if (settled) return;
		settled = true;
		reject(error);
	};
	child.once("error", error => settleError(error instanceof Error ? error : new Error(String(error))));
	child.once("exit", (code, signal) => {
		if (!settled) settleError(new Error(`OMP Studio sidecar exited before ready (${code ?? signal ?? "unknown"}).`));
	});
	child.stderr.on("data", () => undefined);

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
				if (child.exitCode !== null) return;
				child.kill();
				await once(child, "exit").catch(() => undefined);
			},
		};
	} catch (error) {
		lines.close();
		if (child.exitCode === null) child.kill();
		throw error;
	}
}
