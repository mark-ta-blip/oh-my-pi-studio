import * as childProcess from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(childProcess.execFile);

/** A `ps`/`taskkill` probe must not hold shutdown open if the OS is unresponsive. */
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 5_000;

/** One parent/child edge of the local process table. */
export interface ProcessTreeRow {
	parentPid: number;
	pid: number;
}

/**
 * Platform operations the tree helpers need, injected so the Windows and POSIX
 * decisions are both testable from either platform.
 */
export interface ProcessTreeControl {
	/** `pid ppid` pairs, one per line. POSIX only; Windows resolves the tree inside `taskkill`. */
	listProcesses(): Promise<string>;
	platform: NodeJS.Platform;
	/** Run a command, reporting whether it exited successfully. */
	run(command: string, args: readonly string[]): Promise<boolean>;
	sendSignal(pid: number, signal: NodeJS.Signals): void;
}

/** Parse `ps -ax -o pid=,ppid=` output, skipping anything that is not a pid pair. */
export function parseProcessTreeRows(output: string): ProcessTreeRow[] {
	const rows: ProcessTreeRow[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const parentPid = Number(match[2]);
		if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) continue;
		rows.push({ parentPid, pid });
	}
	return rows;
}

/**
 * Every descendant of `rootPid`, deepest first.
 *
 * Deepest-first is the order they must be signalled in: killing a parent before
 * its children reparents the children and loses them. Self-parenting rows and
 * cycles are ignored rather than trusted, because this walks output parsed from
 * another process.
 */
export function collectDescendantPids(rows: readonly ProcessTreeRow[], rootPid: number): number[] {
	const childrenByParent = new Map<number, number[]>();
	for (const row of rows) {
		if (row.pid === row.parentPid) continue;
		const siblings = childrenByParent.get(row.parentPid);
		if (siblings) siblings.push(row.pid);
		else childrenByParent.set(row.parentPid, [row.pid]);
	}

	const descendants: number[] = [];
	const visited = new Set<number>([rootPid]);
	const visit = (pid: number): void => {
		for (const child of childrenByParent.get(pid) ?? []) {
			if (visited.has(child)) continue;
			visited.add(child);
			visit(child);
			descendants.push(child);
		}
	};
	visit(rootPid);
	return descendants;
}

export function createProcessTreeControl(): ProcessTreeControl {
	return {
		async listProcesses(): Promise<string> {
			try {
				const { stdout } = await execFile("ps", ["-ax", "-o", "pid=,ppid="], {
					encoding: "utf8",
					timeout: PROCESS_TREE_COMMAND_TIMEOUT_MS,
				});
				return stdout;
			} catch {
				// Without a process table the force pass degrades to the root pid only.
				return "";
			}
		},
		platform: process.platform,
		async run(command: string, args: readonly string[]): Promise<boolean> {
			try {
				await execFile(command, [...args], {
					encoding: "utf8",
					timeout: PROCESS_TREE_COMMAND_TIMEOUT_MS,
					windowsHide: true,
				});
				return true;
			} catch {
				// `taskkill` exits non-zero when the target is already gone, and when a
				// console process refuses a graceful close. Both are the caller's cue
				// to stop waiting, not an error to report.
				return false;
			}
		},
		sendSignal(pid: number, signal: NodeJS.Signals): void {
			try {
				process.kill(pid, signal);
			} catch {
				// The process exited between the table read and the signal.
			}
		},
	};
}

/**
 * Ask a sidecar to shut itself down, returning whether the request was accepted.
 *
 * Only the root is signalled. The OMP sidecar's own SIGTERM handler stops its RPC
 * children through the Studio supervisor, which unwinds session state; signalling
 * those children directly would skip that.
 *
 * Windows has no SIGTERM. `taskkill` without `/F` asks a window to close, which a
 * console process normally refuses — hence the boolean, so the caller can go
 * straight to the force pass instead of waiting out a grace period that will
 * never be used.
 */
export async function requestGracefulTreeStop(pid: number, control: ProcessTreeControl): Promise<boolean> {
	if (control.platform === "win32") {
		return await control.run("taskkill.exe", ["/PID", String(pid), "/T"]);
	}
	control.sendSignal(pid, "SIGTERM");
	return true;
}

/**
 * Terminate a sidecar and everything it spawned.
 *
 * This is the pass that fixes orphaned OMP RPC children: `ChildProcess.kill()` on
 * Windows maps to `TerminateProcess` on the root alone, so every
 * `omp --mode rpc-ui` process the sidecar started for a session outlives the app.
 */
export async function forceKillTree(pid: number, control: ProcessTreeControl): Promise<void> {
	if (control.platform === "win32") {
		await control.run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
		return;
	}
	const rows = parseProcessTreeRows(await control.listProcesses());
	for (const descendant of collectDescendantPids(rows, pid)) control.sendSignal(descendant, "SIGKILL");
	control.sendSignal(pid, "SIGKILL");
}
