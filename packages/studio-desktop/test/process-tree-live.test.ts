import { expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as readline from "node:readline";
import { createProcessTreeControl, forceKillTree } from "../src/main/process-tree";

/**
 * Termination against real processes, not a recorded control.
 *
 * The unit tests prove which command is issued; these prove the command works.
 * The shape mirrors what the shell actually supervises: OMP Studio spawns an
 * `omp studio` sidecar, which spawns one `omp --mode rpc-ui` child per session.
 * The shell has no handle to that grandchild.
 *
 * The grandchild is spawned detached on purpose. Some runtimes — Bun on Windows
 * among them — put non-detached children in a job object that the OS tears down
 * with the parent, which would clean up the tree for reasons that have nothing to
 * do with the code under test. Detaching removes that assist so these tests
 * measure the tree walk itself, on every platform.
 */

const PROCESS_EXIT_POLL_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 50;

function isAlive(pid: number): boolean {
	try {
		// Signal 0 performs an existence check without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilGone(pid: number): Promise<boolean> {
	const deadline = Date.now() + PROCESS_EXIT_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await Bun.sleep(PROCESS_EXIT_POLL_INTERVAL_MS);
	}
	return false;
}

/** A parent that spawns one long-lived detached grandchild and reports its pid. */
const PARENT_SCRIPT = `
const childProcess = require("node:child_process");
const grandchild = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => undefined, 600000);"], {
	detached: true,
	stdio: "ignore",
});
grandchild.unref();
console.log("grandchild " + grandchild.pid);
setTimeout(() => undefined, 600000);
`;

interface ProcessTreeFixture {
	exited: Promise<void>;
	grandchildPid: number;
	parent: childProcess.ChildProcess;
}

async function spawnProcessTreeFixture(): Promise<ProcessTreeFixture> {
	const parent = childProcess.spawn(process.execPath, ["-e", PARENT_SCRIPT], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = new Promise<void>(resolve => parent.once("exit", () => resolve()));
	if (!parent.stdout) throw new Error("The process-tree fixture did not expose stdout.");
	for await (const line of readline.createInterface({ input: parent.stdout })) {
		const match = /^grandchild (\d+)$/.exec(line.trim());
		if (match) return { exited, grandchildPid: Number(match[1]), parent };
	}
	throw new Error("The process-tree fixture never reported a grandchild pid.");
}

function cleanUpFixture(fixture: ProcessTreeFixture): void {
	const { grandchildPid, parent } = fixture;
	if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
	if (isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
}

test("force killing a real tree takes the grandchild with it", async () => {
	const fixture = await spawnProcessTreeFixture();
	try {
		expect(isAlive(fixture.grandchildPid)).toBe(true);

		await forceKillTree(fixture.parent.pid as number, createProcessTreeControl());

		await fixture.exited;
		// A grandchild the caller never spawned, and has no handle to, is gone.
		expect(await waitUntilGone(fixture.grandchildPid)).toBe(true);
	} finally {
		cleanUpFixture(fixture);
	}
});

test("killing only the root leaves the grandchild running", async () => {
	const fixture = await spawnProcessTreeFixture();
	try {
		// What ChildProcess.kill() does on Windows, and what a bare SIGKILL does
		// everywhere: it reaches the root and stops there.
		fixture.parent.kill("SIGKILL");
		await fixture.exited;
		await Bun.sleep(PROCESS_EXIT_POLL_INTERVAL_MS * 4);

		expect(isAlive(fixture.grandchildPid)).toBe(true);
	} finally {
		cleanUpFixture(fixture);
	}
});
