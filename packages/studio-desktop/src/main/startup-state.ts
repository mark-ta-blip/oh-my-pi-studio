import { t } from "./strings";
import { StudioSidecarStartupError } from "./studio-server";

/**
 * What the shell is waiting for. The splash renders these as static wording, so a
 * new stage is a deliberate protocol change rather than a free-form message.
 */
export type StudioStartupStage = "locating" | "starting" | "loading";

export interface StudioStartupProgress {
	kind: "progress";
	stage: StudioStartupStage;
}

/**
 * A startup that gave up, carrying everything the user needs to act: the reason,
 * the sidecar's own last words, and where the full log is.
 */
export interface StudioStartupFailure {
	kind: "failure";
	logPath?: string;
	message: string;
	stderrTail: readonly string[];
}

export type StudioStartupState = StudioStartupProgress | StudioStartupFailure;

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Split a startup error into the parts the splash renders separately. */
export function toStudioStartupFailure(error: unknown): StudioStartupFailure {
	const message = describeError(error);
	if (!(error instanceof StudioSidecarStartupError)) return { kind: "failure", message, stderrTail: [] };
	return {
		kind: "failure",
		...(error.logPath === undefined ? {} : { logPath: error.logPath }),
		message,
		stderrTail: [...error.stderrTail],
	};
}

/**
 * Flatten a failure into one block of text.
 *
 * Used for the stderr line the shell always writes, and for the clipboard copy the
 * splash offers, so a bug report carries the same content either way.
 */
export function formatStudioStartupFailure(failure: StudioStartupFailure): string {
	const sections = [failure.message];
	if (failure.stderrTail.length > 0) {
		sections.push(`${t("failure.serverOutput")}:\n${failure.stderrTail.join("\n")}`);
	}
	if (failure.logPath) sections.push(`${t("failure.serverLog")}:\n${failure.logPath}`);
	return sections.join("\n\n");
}

/** The splash's static wording for a stage. */
export function studioStartupStageLabel(stage: StudioStartupStage): string {
	switch (stage) {
		case "locating":
			return t("stage.locating");
		case "starting":
			return t("stage.starting");
		case "loading":
			return t("stage.loading");
	}
}
