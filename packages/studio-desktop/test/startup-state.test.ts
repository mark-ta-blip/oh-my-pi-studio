import { expect, test } from "bun:test";
import { formatStudioStartupFailure, studioStartupStageLabel, toStudioStartupFailure } from "../src/main/startup-state";
import { StudioSidecarStartupError } from "../src/main/studio-server";

test("keeps the sidecar's own diagnostics on a startup failure", () => {
	const failure = toStudioStartupFailure(
		new StudioSidecarStartupError(
			"Timed out waiting 30s for OMP Studio sidecar.",
			["port in use", "giving up"],
			"C:/logs/studio-server.log",
		),
	);

	expect(failure).toEqual({
		kind: "failure",
		logPath: "C:/logs/studio-server.log",
		message: "Timed out waiting 30s for OMP Studio sidecar.",
		stderrTail: ["port in use", "giving up"],
	});
});

test("reduces an ordinary error to a message with nothing invented around it", () => {
	expect(toStudioStartupFailure(new Error("spawn omp.exe ENOENT"))).toEqual({
		kind: "failure",
		message: "spawn omp.exe ENOENT",
		stderrTail: [],
	});
	expect(toStudioStartupFailure("not an error")).toEqual({
		kind: "failure",
		message: "not an error",
		stderrTail: [],
	});
});

test("omits the log path when the log could not be opened", () => {
	const failure = toStudioStartupFailure(new StudioSidecarStartupError("failed", ["only line"], undefined));

	expect("logPath" in failure).toBe(false);
	expect(failure.stderrTail).toEqual(["only line"]);
});

test("flattens a failure into one block a bug report can carry", () => {
	const text = formatStudioStartupFailure({
		kind: "failure",
		logPath: "C:/logs/studio-server.log",
		message: "Timed out.",
		stderrTail: ["first", "second"],
	});

	expect(text).toBe(
		"Timed out.\n\nRecent OMP Studio server output:\nfirst\nsecond\n\nFull server log:\nC:/logs/studio-server.log",
	);
});

test("leaves out the sections a failure has nothing for", () => {
	expect(formatStudioStartupFailure({ kind: "failure", message: "Timed out.", stderrTail: [] })).toBe("Timed out.");
});

test("gives every startup stage its own static wording", () => {
	const labels = (["locating", "starting", "loading"] as const).map(studioStartupStageLabel);

	expect(new Set(labels).size).toBe(labels.length);
	for (const label of labels) expect(label.length).toBeGreaterThan(0);
});
