import { afterEach, expect, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import type { ProcessTreeControl } from "../src/main/process-tree";
import { openSidecarLogSink } from "../src/main/sidecar-log";
import { StudioSidecarStartupError, superviseStudioSidecar } from "../src/main/studio-server";

type FakeSidecar = childProcess.ChildProcessByStdio<null, Readable, Readable>;

const READY_URL = "http://127.0.0.1:49213/?token=fixture-access-token";

/**
 * A process-tree control that records the termination sequence and, optionally,
 * really ends the child so the supervisor's waits resolve. Platform is forced so
 * both branches are exercised regardless of the host running the suite.
 */
function recordTermination(child: FakeSidecar, options: { obeysGracefulStop: boolean }) {
	const steps: string[] = [];
	const control: ProcessTreeControl = {
		listProcesses: async () => "",
		platform: "linux",
		run: async () => true,
		sendSignal: (_pid, signal) => {
			steps.push(signal);
			if (signal === "SIGKILL" || options.obeysGracefulStop) child.kill("SIGKILL");
		},
	};
	return { control, steps };
}

const children: FakeSidecar[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	for (const root of tempRoots.splice(0)) await fs.rm(root, { force: true, recursive: true });
});

/** A sidecar that announces and honours the shell's stdin control channel. */
const OBEYS_CONTROL_CHANNEL = `
	const readline = require("node:readline");
	readline.createInterface({ input: process.stdin }).on("line", line => {
		if (line.trim() === "shutdown") process.exit(0);
	});
	console.log("OMP Studio control channel: stdin");
`;

/**
 * Spawn a throwaway process standing in for the OMP sidecar.
 *
 * The real sidecar announces and honours the stdin control channel, so fakes do
 * too by default. Pass `obeysControlChannel: false` for a sidecar built before the
 * channel existed, which is what exercises the signal and force fallbacks.
 */
function spawnFakeSidecar(script: string, options: { obeysControlChannel?: boolean } = {}): FakeSidecar {
	const source = options.obeysControlChannel === false ? script : `${OBEYS_CONTROL_CHANNEL}\n${script}`;
	const child = childProcess.spawn(process.execPath, ["-e", source], {
		// stdin is piped because the shell uses it as the sidecar's control channel.
		stdio: ["pipe", "pipe", "pipe"],
	}) as FakeSidecar;
	children.push(child);
	return child;
}

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-desktop-"));
	tempRoots.push(root);
	return root;
}

test("resolves the sidecar URL from the ready line and ignores unrelated output", async () => {
	const child = spawnFakeSidecar(
		`console.log("Starting OMP...");
		 console.log("OMP Studio available at: ${READY_URL}");
		 setTimeout(() => undefined, 30000);`,
	);

	const server = await superviseStudioSidecar(child, { readyTimeoutMs: 10_000 });

	expect(server.url).toBe(READY_URL);
	await server.stop();
	expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("stops on the control-channel request without ever signalling the sidecar", async () => {
	const child = spawnFakeSidecar(
		`console.log("OMP Studio available at: ${READY_URL}");
		 setTimeout(() => undefined, 30000);`,
	);
	const termination = recordTermination(child, { obeysGracefulStop: false });

	const server = await superviseStudioSidecar(child, {
		processTree: termination.control,
		readyTimeoutMs: 10_000,
		stopGraceMs: 5_000,
	});
	await server.stop();

	// The whole point of the channel: on Windows this is the only stop that lets
	// the sidecar run its own Studio teardown, so nothing may be signalled here.
	expect(termination.steps).toEqual([]);
	expect(child.exitCode).toBe(0);
});

test("falls back to a signal when the sidecar predates the control channel", async () => {
	const child = spawnFakeSidecar(
		`console.log("OMP Studio available at: ${READY_URL}");
		 setTimeout(() => undefined, 30000);`,
		{ obeysControlChannel: false },
	);
	const termination = recordTermination(child, { obeysGracefulStop: true });

	const server = await superviseStudioSidecar(child, {
		processTree: termination.control,
		readyTimeoutMs: 10_000,
		// Deliberately long: a sidecar that never announced the channel must not be
		// waited on at all, so this grace period should never be spent.
		stopGraceMs: 30_000,
	});
	await server.stop();

	expect(termination.steps).toEqual(["SIGTERM"]);
	expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("forces the whole tree when the sidecar ignores the stop request", async () => {
	const child = spawnFakeSidecar(
		`process.on("SIGTERM", () => undefined);
		 console.log("OMP Studio available at: ${READY_URL}");
		 setTimeout(() => undefined, 30000);`,
		{ obeysControlChannel: false },
	);
	const termination = recordTermination(child, { obeysGracefulStop: false });

	const server = await superviseStudioSidecar(child, {
		processTree: termination.control,
		readyTimeoutMs: 10_000,
		stopGraceMs: 150,
	});
	await server.stop();

	expect(termination.steps).toEqual(["SIGTERM", "SIGKILL"]);
	expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("rejects a ready line that does not point at a local sidecar", async () => {
	const child = spawnFakeSidecar(
		`console.log("OMP Studio available at: http://studio.example.com/?token=leaked");
		 setTimeout(() => undefined, 30000);`,
	);

	// A non-loopback URL must never satisfy startup; it falls through to the timeout.
	await expect(superviseStudioSidecar(child, { readyTimeoutMs: 150 })).rejects.toThrow(
		/Timed out waiting .* for OMP Studio sidecar\./,
	);
});

test("times out when the sidecar never announces itself", async () => {
	const child = spawnFakeSidecar("setTimeout(() => undefined, 30000);");

	const error = await superviseStudioSidecar(child, { readyTimeoutMs: 120 }).catch((cause: unknown) => cause);

	expect(error).toBeInstanceOf(StudioSidecarStartupError);
	expect((error as StudioSidecarStartupError).message).toMatch(/Timed out waiting 0\.12s for OMP Studio sidecar\./);
	expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("rejects and stops the sidecar when startup is aborted", async () => {
	const child = spawnFakeSidecar("setTimeout(() => undefined, 30000);");
	const abort = new AbortController();

	const supervision = superviseStudioSidecar(child, { readyTimeoutMs: 10_000, signal: abort.signal });
	abort.abort();

	await expect(supervision).rejects.toThrow("OMP Studio startup was cancelled.");
	expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("reports the sidecar's own stderr when it exits before becoming ready", async () => {
	const child = spawnFakeSidecar(
		`console.error("studio: port 7777 already in use");
		 console.error("studio: giving up");
		 process.exit(3);`,
	);

	const error = await superviseStudioSidecar(child, { readyTimeoutMs: 10_000 }).catch((cause: unknown) => cause);

	expect(error).toBeInstanceOf(StudioSidecarStartupError);
	// 'exit' and the stdout EOF race, and either diagnostic is correct; what must
	// hold is that startup fails fast and carries the sidecar's stderr.
	expect((error as StudioSidecarStartupError).message).toMatch(
		/exited before ready \(3\)|closed its output before becoming ready/,
	);
	expect((error as StudioSidecarStartupError).stderrTail).toEqual([
		"studio: port 7777 already in use",
		"studio: giving up",
	]);
});

test("keeps only the most recent stderr lines and bounds their length", async () => {
	const child = spawnFakeSidecar(
		`for (let index = 0; index < 25; index += 1) console.error("line-" + index);
		 console.error("x".repeat(900));
		 process.exit(1);`,
	);

	const error = (await superviseStudioSidecar(child, { readyTimeoutMs: 10_000 }).catch(
		(cause: unknown) => cause,
	)) as StudioSidecarStartupError;

	expect(error.stderrTail).toHaveLength(20);
	expect(error.stderrTail[0]).toBe("line-6");
	const lastLine = error.stderrTail[19];
	expect(lastLine).toHaveLength(400);
	expect(lastLine.endsWith("...")).toBe(true);
});

test("mirrors sidecar stderr into the log file and names it on the error", async () => {
	const root = await makeTempRoot();
	const logPath = path.join(root, "logs", "studio-server.log");
	const logSink = await openSidecarLogSink(logPath);
	const child = spawnFakeSidecar(`console.error("studio: fatal config error"); process.exit(2);`);

	const error = (await superviseStudioSidecar(child, { readyTimeoutMs: 10_000, logSink }).catch(
		(cause: unknown) => cause,
	)) as StudioSidecarStartupError;

	expect(error.logPath).toBe(logPath);
	expect(await fs.readFile(logPath, "utf8")).toContain("studio: fatal config error");
});

test("degrades to an in-memory tail when the log file cannot be opened", async () => {
	const root = await makeTempRoot();
	// A file where the log's parent directory should be: mkdir fails on every platform.
	const blocker = path.join(root, "logs");
	await fs.writeFile(blocker, "not a directory", "utf8");

	const logSink = await openSidecarLogSink(path.join(blocker, "studio-server.log"));

	expect(logSink.path).toBeUndefined();
	logSink.write("still accepted\n");
	await logSink.close();
});

test("rotates the sidecar log once it passes its size cap", async () => {
	const root = await makeTempRoot();
	const logPath = path.join(root, "studio-server.log");
	await fs.writeFile(logPath, "x".repeat(1_048_577), "utf8");

	const logSink = await openSidecarLogSink(logPath);
	logSink.write("fresh run\n");
	await logSink.close();

	expect(await fs.readFile(logPath, "utf8")).toBe("fresh run\n");
});

test("appends to a sidecar log that is still under its size cap", async () => {
	const root = await makeTempRoot();
	const logPath = path.join(root, "studio-server.log");
	await fs.writeFile(logPath, "previous run\n", "utf8");

	const logSink = await openSidecarLogSink(logPath);
	logSink.write("current run\n");
	await logSink.close();

	expect(await fs.readFile(logPath, "utf8")).toBe("previous run\ncurrent run\n");
});
