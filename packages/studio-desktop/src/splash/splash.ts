/**
 * Splash renderer.
 *
 * The main process pushes typed startup state over one channel and this document
 * renders it. No progress text is computed here and nothing is injected from the
 * main process — the shell never evaluates script in this window.
 */

interface SplashBridge {
	copyFailure(): Promise<void>;
	onState(listener: (state: unknown) => void): void;
	openLogFolder(): Promise<void>;
	requestState(): Promise<unknown>;
	retry(): Promise<void>;
}

type StartupStage = "locating" | "starting" | "loading";

interface StartupProgress {
	kind: "progress";
	stage: StartupStage;
}

interface StartupFailure {
	kind: "failure";
	logPath?: string;
	message: string;
	stderrTail: readonly string[];
}

const STAGE_LABELS: Record<StartupStage, string> = {
	loading: "Opening the workbench",
	locating: "Locating the OMP runtime",
	starting: "Starting the local OMP server",
};

const bridge = (window as unknown as { ompStudioSplash?: SplashBridge }).ompStudioSplash;

function element<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) throw new Error(`OMP Studio splash is missing #${id}.`);
	return found as T;
}

const progressSection = element("progress");
const stageLabel = element("stage");
const failureSection = element("failure");
const failureMessage = element("failure-message");
const failureOutput = element("failure-output");
const failureLog = element("failure-log");
const retryButton = element<HTMLButtonElement>("retry");
const logsButton = element<HTMLButtonElement>("logs");
const copyButton = element<HTMLButtonElement>("copy");

function isStage(value: unknown): value is StartupStage {
	return value === "locating" || value === "starting" || value === "loading";
}

function parseState(value: unknown): StartupProgress | StartupFailure | null {
	if (!value || typeof value !== "object") return null;
	const state = value as Record<string, unknown>;
	if (state.kind === "progress" && isStage(state.stage)) return { kind: "progress", stage: state.stage };
	if (state.kind !== "failure" || typeof state.message !== "string") return null;
	const stderrTail = Array.isArray(state.stderrTail)
		? state.stderrTail.filter((line): line is string => typeof line === "string")
		: [];
	return {
		kind: "failure",
		...(typeof state.logPath === "string" ? { logPath: state.logPath } : {}),
		message: state.message,
		stderrTail,
	};
}

function renderProgress(state: StartupProgress): void {
	failureSection.hidden = true;
	progressSection.hidden = false;
	stageLabel.textContent = STAGE_LABELS[state.stage];
	retryButton.disabled = false;
}

function renderFailure(state: StartupFailure): void {
	progressSection.hidden = true;
	failureSection.hidden = false;
	failureMessage.textContent = state.message;
	failureOutput.hidden = state.stderrTail.length === 0;
	failureOutput.textContent = state.stderrTail.join("\n");
	failureLog.hidden = state.logPath === undefined;
	failureLog.textContent = state.logPath ?? "";
	logsButton.hidden = state.logPath === undefined;
	retryButton.disabled = false;
	retryButton.focus();
}

function render(value: unknown): void {
	const state = parseState(value);
	if (!state) return;
	if (state.kind === "progress") renderProgress(state);
	else renderFailure(state);
}

function bindAction(button: HTMLButtonElement, action: () => Promise<void>, keepDisabled: boolean): void {
	button.addEventListener("click", () => {
		button.disabled = true;
		void action()
			.catch(() => undefined)
			.finally(() => {
				if (!keepDisabled) button.disabled = false;
			});
	});
}

if (bridge) {
	bindAction(retryButton, () => bridge.retry(), true);
	bindAction(logsButton, () => bridge.openLogFolder(), false);
	bindAction(copyButton, () => bridge.copyFailure(), false);
	bridge.onState(render);
	// The first state may have been published before this document finished
	// loading, so the current one is pulled rather than waited for.
	void bridge.requestState().then(render);
}
