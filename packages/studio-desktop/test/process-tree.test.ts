import { expect, test } from "bun:test";
import {
	collectDescendantPids,
	forceKillTree,
	type ProcessTreeControl,
	parseProcessTreeRows,
	requestGracefulTreeStop,
} from "../src/main/process-tree";

interface RecordedProcessTree {
	commands: string[][];
	control: ProcessTreeControl;
	signals: Array<[number, NodeJS.Signals]>;
}

function recordProcessTree(platform: NodeJS.Platform, options: { processes?: string; run?: boolean } = {}) {
	const commands: string[][] = [];
	const signals: Array<[number, NodeJS.Signals]> = [];
	const control: ProcessTreeControl = {
		listProcesses: async () => options.processes ?? "",
		platform,
		run: async (command, args) => {
			commands.push([command, ...args]);
			return options.run ?? true;
		},
		sendSignal: (pid, signal) => {
			signals.push([pid, signal]);
		},
	};
	return { commands, control, signals } satisfies RecordedProcessTree;
}

test("parses pid pairs and ignores header or malformed lines", () => {
	const rows = parseProcessTreeRows("  PID  PPID\n 4321   1\n\t9001\t4321\nnot a row\n42 x\n");

	expect(rows).toEqual([
		{ parentPid: 1, pid: 4321 },
		{ parentPid: 4321, pid: 9001 },
	]);
});

test("collects descendants deepest first so a parent is never signalled before its children", () => {
	const rows = parseProcessTreeRows(["100 1", "200 100", "300 200", "400 100", "500 999"].join("\n"));

	expect(collectDescendantPids(rows, 100)).toEqual([300, 200, 400]);
	expect(collectDescendantPids(rows, 999)).toEqual([500]);
	expect(collectDescendantPids(rows, 12345)).toEqual([]);
});

test("survives a self-parented row and a cycle in the reported table", () => {
	const selfParented = collectDescendantPids([{ parentPid: 7, pid: 7 }], 7);
	const cycle = collectDescendantPids(
		[
			{ parentPid: 1, pid: 2 },
			{ parentPid: 2, pid: 3 },
			{ parentPid: 3, pid: 2 },
		],
		1,
	);

	expect(selfParented).toEqual([]);
	expect(cycle).toEqual([3, 2]);
});

test("asks the sidecar to stop with SIGTERM on POSIX and never signals its children", () => {
	const recorded = recordProcessTree("linux", { processes: "100 1\n200 100\n" });

	const accepted = requestGracefulTreeStop(100, recorded.control);

	expect(recorded.commands).toEqual([]);
	// Only the root: its own handler is what unwinds the OMP RPC children.
	expect(recorded.signals).toEqual([[100, "SIGTERM"]]);
	return expect(accepted).resolves.toBe(true);
});

test("asks the tree to close on Windows and reports a refusal so the caller stops waiting", async () => {
	const accepted = recordProcessTree("win32");
	const refused = recordProcessTree("win32", { run: false });

	expect(await requestGracefulTreeStop(4321, accepted.control)).toBe(true);
	expect(await requestGracefulTreeStop(4321, refused.control)).toBe(false);
	expect(accepted.commands).toEqual([["taskkill.exe", "/PID", "4321", "/T"]]);
	expect(accepted.signals).toEqual([]);
});

test("force kill walks the tree leaves-first on POSIX", async () => {
	const recorded = recordProcessTree("linux", {
		processes: ["100 1", "200 100", "300 200", "400 100"].join("\n"),
	});

	await forceKillTree(100, recorded.control);

	expect(recorded.signals).toEqual([
		[300, "SIGKILL"],
		[200, "SIGKILL"],
		[400, "SIGKILL"],
		[100, "SIGKILL"],
	]);
});

test("force kill still signals the root when the process table is unavailable", async () => {
	const recorded = recordProcessTree("linux", { processes: "" });

	await forceKillTree(100, recorded.control);

	expect(recorded.signals).toEqual([[100, "SIGKILL"]]);
});

test("force kill delegates the whole tree to taskkill on Windows", async () => {
	const recorded = recordProcessTree("win32");

	await forceKillTree(4321, recorded.control);

	// /T is what keeps `omp --mode rpc-ui` grandchildren from being orphaned.
	expect(recorded.commands).toEqual([["taskkill.exe", "/PID", "4321", "/T", "/F"]]);
	expect(recorded.signals).toEqual([]);
});
