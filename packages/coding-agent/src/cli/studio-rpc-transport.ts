import { isPromise } from "node:util/types";
import type {
	StudioRpcAgentEvent,
	StudioRpcApprovalRequest,
	StudioRpcLaunch,
	StudioRpcPlanSummary,
	StudioRpcPromptResult,
	StudioRpcSessionState,
	StudioRpcTranscriptUpdate,
	StudioRpcTransport,
	StudioRpcTransportExit,
	StudioRpcTransportFactory,
	StudioRpcUsage,
	StudioSubagent,
} from "@oh-my-pi/omp-studio";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder } from "../modes/rpc/rpc-frame";
import type { RpcCommand, RpcExtensionUIResponse, RpcPromptResultFrame, RpcResponse } from "../modes/rpc/rpc-types";
import { studioRpcChildEnvironment } from "../secrets/studio-secret-redaction";
import { resolveOmpCommandInvocation } from "../task/omp-command";

const RPC_START_TIMEOUT_MS = 30_000;
const MAX_TRACKED_TOOL_CALLS = 256;
const MAX_STUDIO_TRANSCRIPT_TEXT_LENGTH = 64 * 1024;
const MAX_STUDIO_PLAN_PHASES = 512;
const MAX_STUDIO_PLAN_TASKS = 4_096;
const STUDIO_APPROVAL_REASON = "OMP requires confirmation for this tool.";

const SESSION_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"model_changed",
	"goal_updated",
]);

type StudioRpcCommand =
	| { type: "negotiate_protocol"; protocolVersion: 2 }
	| { type: "get_state" }
	| { type: "get_session_stats" }
	| { type: "prompt"; message: string }
	| { type: "set_subagent_subscription"; level: "events" }
	| { type: "abort" };

interface PendingRequest {
	command: StudioRpcCommand["type"];
	reject(error: Error): void;
	resolve(response: RpcResponse): void;
	timeout: Timer;
}

interface StudioApprovalFrame extends Record<string, unknown> {
	id: string;
	method: "tool_approval";
	toolCallId: string;
	toolName: string;
	type: "extension_ui_request";
	reason?: string;
}

function supportsRpcProtocolV2(value: Record<string, unknown>): boolean {
	return (
		value.type === "ready" &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.includes(2) &&
		value.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		value.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
	);
}

function isRpcResponse(value: unknown): value is RpcResponse {
	return (
		isRecord(value) &&
		value.type === "response" &&
		typeof value.command === "string" &&
		typeof value.success === "boolean" &&
		(value.id === undefined || typeof value.id === "string")
	);
}

function isRpcPromptResultFrame(value: unknown): value is RpcPromptResultFrame {
	return (
		isRecord(value) &&
		value.type === "prompt_result" &&
		(value.id === undefined || typeof value.id === "string") &&
		typeof value.agentInvoked === "boolean"
	);
}

function isSessionEvent(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && typeof value.type === "string" && SESSION_EVENT_TYPES.has(value.type);
}

function isStudioApprovalRequest(value: unknown): value is StudioApprovalFrame {
	return (
		isRecord(value) &&
		value.type === "extension_ui_request" &&
		value.method === "tool_approval" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

function isSubagentFrame(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value) &&
		(value.type === "subagent_lifecycle" || value.type === "subagent_progress") &&
		isRecord(value.payload)
	);
}

function numberValue(value: Record<string, unknown>, key: string): number | undefined {
	const candidate = value[key];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function subagentStatus(value: unknown): StudioSubagent["status"] | undefined {
	return value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "aborted"
		? value
		: undefined;
}

function toStudioSubagent(frame: Record<string, unknown>): StudioSubagent | undefined {
	const payload = frame.payload;
	if (!isRecord(payload)) return undefined;
	if (frame.type === "subagent_lifecycle") {
		const status = payload.status === "started" ? "running" : subagentStatus(payload.status);
		const index = numberValue(payload, "index");
		if (
			!status ||
			typeof payload.id !== "string" ||
			typeof payload.agent !== "string" ||
			typeof payload.agentSource !== "string" ||
			index === undefined ||
			!Number.isInteger(index)
		) {
			return undefined;
		}
		return {
			id: payload.id,
			index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			status,
			updatedAtMs: Date.now(),
		};
	}
	const progress = payload.progress;
	const index = numberValue(payload, "index");
	if (
		!isRecord(progress) ||
		typeof progress.id !== "string" ||
		typeof payload.agent !== "string" ||
		typeof payload.agentSource !== "string" ||
		index === undefined ||
		!Number.isInteger(index)
	) {
		return undefined;
	}
	const status = subagentStatus(progress.status);
	if (!status) return undefined;
	const toolCount = numberValue(progress, "toolCount");
	const requestCount = numberValue(progress, "requests");
	const tokenCount = numberValue(progress, "tokens");
	const cost = numberValue(progress, "cost");
	return {
		id: progress.id,
		index,
		agent: payload.agent,
		agentSource: payload.agentSource,
		status,
		...(toolCount === undefined ? {} : { toolCount }),
		...(requestCount === undefined ? {} : { requestCount }),
		...(tokenCount === undefined ? {} : { tokenCount }),
		...(cost === undefined ? {} : { cost }),
		updatedAtMs: Date.now(),
	};
}

/** Redact a native OMP event before it leaves coding-agent for Studio's server-side supervisor. */
export function redactStudioAgentEvent(event: Record<string, unknown>): StudioRpcAgentEvent {
	const base: StudioRpcAgentEvent = { type: event.type as string };
	if (typeof event.isTerminal === "boolean") base.isTerminal = event.isTerminal;
	if (typeof event.isError === "boolean") base.isError = event.isError;
	if (typeof event.toolCallId === "string") base.toolCallId = event.toolCallId;
	if (typeof event.toolName === "string") base.toolName = event.toolName;
	return base;
}

/**
 * Extract the explicitly displayable portion of an assistant frame. This is
 * intentionally separate from generic Studio agent-event redaction: no tool
 * arguments/results, thinking, images, provider payloads, or OMP identifiers
 * can cross this boundary.
 */
export function extractStudioAssistantTranscriptText(event: Record<string, unknown>): string | undefined {
	if (event.type !== "message_update" && event.type !== "message_end") return undefined;
	const message = event.message;
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	let text = "";
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		text += block.text;
		if (text.length >= MAX_STUDIO_TRANSCRIPT_TEXT_LENGTH) {
			return text.slice(0, MAX_STUDIO_TRANSCRIPT_TEXT_LENGTH);
		}
	}
	return text || undefined;
}

export function studioAssistantMessageKeys(message: Record<string, unknown>): string[] {
	const keys: string[] = [];
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
		keys.push(`timestamp:${message.timestamp}`);
	}
	if (typeof message.responseId === "string" && message.responseId) {
		keys.push(`response:${message.responseId}`);
	}
	return keys;
}

function isAssistantMessageError(frame: Record<string, unknown>): boolean {
	if (frame.type !== "message_end" || !isRecord(frame.message)) return false;
	return frame.message.role === "assistant" && frame.message.stopReason === "error";
}

/** Reduce a native todo result to bounded counters; task descriptions stay server-side. */
export function extractStudioPlanSummary(event: Record<string, unknown>): StudioRpcPlanSummary | undefined {
	if (event.type !== "tool_execution_end" || event.toolName !== "todo" || event.isError === true) return undefined;
	const result = isRecord(event.result) ? event.result : undefined;
	const details = result && isRecord(result.details) ? result.details : result;
	const phases = details?.phases;
	if (!Array.isArray(phases)) return undefined;
	let totalTaskCount = 0;
	let pendingTaskCount = 0;
	let inProgressTaskCount = 0;
	let completedTaskCount = 0;
	let blockedTaskCount = 0;
	let abandonedTaskCount = 0;
	let inspectedTaskCount = 0;
	for (const phase of phases.slice(0, MAX_STUDIO_PLAN_PHASES)) {
		if (!isRecord(phase) || !Array.isArray(phase.tasks)) continue;
		for (const task of phase.tasks) {
			if (inspectedTaskCount >= MAX_STUDIO_PLAN_TASKS) break;
			inspectedTaskCount += 1;
			if (!isRecord(task) || typeof task.status !== "string") continue;
			totalTaskCount += 1;
			switch (task.status) {
				case "pending":
					pendingTaskCount += 1;
					break;
				case "in_progress":
					inProgressTaskCount += 1;
					break;
				case "completed":
					completedTaskCount += 1;
					break;
				case "blocked":
					blockedTaskCount += 1;
					break;
				case "abandoned":
					abandonedTaskCount += 1;
					break;
				default:
					totalTaskCount -= 1;
			}
		}
		if (inspectedTaskCount >= MAX_STUDIO_PLAN_TASKS) break;
	}
	return {
		totalTaskCount,
		pendingTaskCount,
		inProgressTaskCount,
		completedTaskCount,
		blockedTaskCount,
		abandonedTaskCount,
	};
}

function canonicalizeToolArguments(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined") return null;
	if (Array.isArray(value)) return value.map(item => canonicalizeToolArguments(item, ancestors));
	if (!isRecord(value)) return String(value);
	if (ancestors.has(value)) return "[circular]";
	ancestors.add(value);
	try {
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) normalized[key] = canonicalizeToolArguments(value[key], ancestors);
		return normalized;
	} finally {
		ancestors.delete(value);
	}
}

function digestToolArguments(argumentsValue: unknown): string {
	const canonical = JSON.stringify(canonicalizeToolArguments(argumentsValue));
	return `sha256:${Bun.SHA256.hash(canonical, "hex")}`;
}

/** Bind a browser-safe approval request to the native arguments without exposing them. */
export function createStudioApprovalRequest(
	request: {
		requestId: string;
		toolCallId: string;
		toolName: string;
		reason?: string;
	},
	argumentsValue: unknown,
): StudioRpcApprovalRequest {
	return {
		requestId: request.requestId,
		toolCallId: request.toolCallId,
		toolName: request.toolName,
		argumentsDigest: digestToolArguments(argumentsValue),
		...(request.reason ? { reason: STUDIO_APPROVAL_REASON } : {}),
	};
}

function rpcCommandFailed(response: RpcResponse, command: StudioRpcCommand["type"]): Error {
	if (response.success && response.command === command)
		return new Error("OMP RPC command did not provide its required data.");
	return new Error("OMP RPC command failed.");
}

function localOnlyPromptResult(response: RpcResponse): StudioRpcPromptResult | undefined {
	if (response.command !== "prompt" || !response.success || response.data?.agentInvoked !== false) return undefined;
	return { agentInvoked: false };
}

/** Coding-agent implementation of Studio's server-only child-process transport. */
class CodingAgentStudioRpcTransport implements StudioRpcTransport {
	#acceptedPromptRequestIds = new Set<string>();
	#approvalListeners = new Set<(request: StudioRpcApprovalRequest) => void>();
	#assistantSourceIds = new Map<string, string>();
	#child: ptree.ChildProcess<"pipe"> | undefined;
	#currentAssistantSourceId: string | undefined;
	#eventListeners = new Set<(event: StudioRpcAgentEvent) => void>();
	#exit: StudioRpcTransportExit | undefined;
	#exitListeners = new Set<(exit: StudioRpcTransportExit) => void>();
	#expectedStop = false;
	#nextAssistantSourceId = 0;
	#pendingApprovals = new Map<string, StudioRpcApprovalRequest>();
	#pendingPromptResults = new Map<string, StudioRpcPromptResult>();
	#planListeners = new Set<(summary: StudioRpcPlanSummary) => void>();
	#pendingRequests = new Map<string, PendingRequest>();
	#promptFailureListeners = new Set<() => void>();
	#promptResultListeners = new Set<(result: StudioRpcPromptResult) => void>();
	#protocolVersion = 1;
	#protocolV2Enabled = false;
	#requestId = 0;
	#subagentListeners = new Set<(subagent: StudioSubagent) => void>();
	#toolArgumentsByCallId = new Map<string, unknown>();
	#terminalAssistantError = false;
	#transcriptListeners = new Set<(update: StudioRpcTranscriptUpdate) => void>();

	constructor(private readonly launch: StudioRpcLaunch) {}

	get protocolVersion(): number {
		return this.#protocolVersion;
	}

	async start(): Promise<void> {
		if (this.#child) throw new Error("Studio RPC transport is already started.");
		const child = ptree.spawn(
			resolveOmpCommandInvocation([
				"--profile",
				this.launch.profile,
				"--mode",
				"rpc-ui",
				"--model",
				`${this.launch.model.provider}/${this.launch.model.id}`,
				...(this.launch.sessionRef ? ["--resume", this.launch.sessionRef] : []),
			]),
			{
				cwd: this.launch.cwd,
				env: studioRpcChildEnvironment(),
				stdin: "pipe",
			},
		);
		this.#child = child;

		const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
		let readySettled = false;
		const rejectStartup = (error: Error): void => {
			if (readySettled) return;
			readySettled = true;
			rejectReady(error);
		};
		const startTimer = setTimeout(() => {
			rejectStartup(new Error("Timed out waiting for OMP RPC startup."));
		}, RPC_START_TIMEOUT_MS);
		startTimer.unref();

		void this.#readOutput(child, frame => {
			if (!readySettled && isRecord(frame) && frame.type === "ready") {
				readySettled = true;
				if (!supportsRpcProtocolV2(frame)) {
					rejectReady(new Error("OMP RPC protocol v2 is unavailable."));
					return;
				}
				resolveReady();
				return;
			}
			this.#handleFrame(frame);
		}).catch(error => {
			const failure = error instanceof Error ? error : new Error("OMP RPC output failed.");
			rejectStartup(failure);
			this.#rejectPending(failure);
			if (!this.#expectedStop) child.kill(undefined, 1_000);
		});

		void child.exited.then(
			() => {
				rejectStartup(new Error("OMP RPC process exited before startup completed."));
				this.#rejectPending(new Error("OMP RPC process exited."));
				this.#notifyExit({ expected: this.#expectedStop });
			},
			() => {
				rejectStartup(new Error("OMP RPC process exited before startup completed."));
				this.#rejectPending(new Error("OMP RPC process exited."));
				this.#notifyExit({ expected: this.#expectedStop });
			},
		);

		try {
			await ready;
			this.#protocolV2Enabled = true;
			const response = await this.#send({ type: "negotiate_protocol", protocolVersion: 2 });
			if (
				!response.success ||
				response.command !== "negotiate_protocol" ||
				!isRecord(response.data) ||
				response.data.protocolVersion !== 2
			) {
				throw new Error("OMP RPC protocol v2 negotiation failed.");
			}
			this.#protocolVersion = 2;
			// Subagent detail is optional; a missing event bus must not block the session itself.
			void this.#send({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
		} catch (error) {
			this.#expectedStop = true;
			await this.stop();
			throw error;
		} finally {
			clearTimeout(startTimer);
		}
	}

	async getSessionState(): Promise<StudioRpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		if (!response.success || response.command !== "get_state" || !isRecord(response.data)) {
			throw rpcCommandFailed(response, "get_state");
		}
		if (typeof response.data.sessionId !== "string" || !response.data.sessionId) {
			throw new Error("OMP RPC session state did not include a session ID.");
		}
		if (response.data.sessionFile !== undefined && typeof response.data.sessionFile !== "string") {
			throw new Error("OMP RPC session state included an invalid session reference.");
		}
		return {
			ompSessionId: response.data.sessionId,
			...(typeof response.data.sessionFile === "string" ? { ompSessionRef: response.data.sessionFile } : {}),
		};
	}

	async getUsage(): Promise<StudioRpcUsage> {
		const response = await this.#send({ type: "get_session_stats" });
		if (!response.success || response.command !== "get_session_stats" || !isRecord(response.data)) {
			throw rpcCommandFailed(response, "get_session_stats");
		}
		const tokens = response.data.tokens;
		if (!isRecord(tokens)) throw new Error("OMP RPC session stats did not include token totals.");
		const inputTokens = numberValue(tokens, "input");
		const outputTokens = numberValue(tokens, "output");
		const reasoningTokens = numberValue(tokens, "reasoning");
		const cacheReadTokens = numberValue(tokens, "cacheRead");
		const cacheWriteTokens = numberValue(tokens, "cacheWrite");
		const totalTokens = numberValue(tokens, "total");
		const premiumRequests = numberValue(response.data, "premiumRequests");
		const cost = numberValue(response.data, "cost");
		const toolCalls = numberValue(response.data, "toolCalls");
		if (
			inputTokens === undefined ||
			outputTokens === undefined ||
			reasoningTokens === undefined ||
			cacheReadTokens === undefined ||
			cacheWriteTokens === undefined ||
			totalTokens === undefined ||
			premiumRequests === undefined ||
			cost === undefined ||
			toolCalls === undefined
		) {
			throw new Error("OMP RPC session stats included invalid usage totals.");
		}
		const contextUsage = response.data.contextUsage;
		const contextTokens = isRecord(contextUsage) ? numberValue(contextUsage, "tokens") : undefined;
		const contextWindow = isRecord(contextUsage) ? numberValue(contextUsage, "contextWindow") : undefined;
		return {
			inputTokens,
			outputTokens,
			reasoningTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens,
			premiumRequests,
			cost,
			toolCalls,
			...(contextTokens === undefined ? {} : { contextTokens }),
			...(contextWindow === undefined ? {} : { contextWindow }),
		};
	}

	onApprovalRequest(listener: (request: StudioRpcApprovalRequest) => void): () => void {
		this.#approvalListeners.add(listener);
		return () => this.#approvalListeners.delete(listener);
	}

	onEvent(listener: (event: StudioRpcAgentEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onExit(listener: (exit: StudioRpcTransportExit) => void): () => void {
		const exit = this.#exit;
		if (exit) listener(exit);
		else this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	onPromptFailure(listener: () => void): () => void {
		this.#promptFailureListeners.add(listener);
		return () => this.#promptFailureListeners.delete(listener);
	}

	onPromptResult(listener: (result: StudioRpcPromptResult) => void): () => void {
		this.#promptResultListeners.add(listener);
		return () => this.#promptResultListeners.delete(listener);
	}

	onPlanSummary(listener: (summary: StudioRpcPlanSummary) => void): () => void {
		this.#planListeners.add(listener);
		return () => this.#planListeners.delete(listener);
	}

	onSubagentState(listener: (subagent: StudioSubagent) => void): () => void {
		this.#subagentListeners.add(listener);
		return () => this.#subagentListeners.delete(listener);
	}

	onTranscriptUpdate(listener: (update: StudioRpcTranscriptUpdate) => void): () => void {
		this.#transcriptListeners.add(listener);
		return () => this.#transcriptListeners.delete(listener);
	}

	async prompt(message: string): Promise<void> {
		const response = await this.#send({ type: "prompt", message });
		if (!response.success || response.command !== "prompt") throw rpcCommandFailed(response, "prompt");
	}

	async abort(): Promise<void> {
		const response = await this.#send({ type: "abort" });
		if (!response.success || response.command !== "abort") throw rpcCommandFailed(response, "abort");
	}

	async resolveApproval(requestId: string, approved: boolean): Promise<void> {
		if (!this.#pendingApprovals.delete(requestId)) {
			throw new Error("OMP tool approval is no longer pending.");
		}
		await this.#writeFrame({
			type: "extension_ui_response",
			id: requestId,
			confirmed: approved,
		} satisfies RpcExtensionUIResponse);
	}

	async stop(): Promise<void> {
		this.#expectedStop = true;
		const child = this.#child;
		if (!child) {
			this.#notifyExit({ expected: true });
			return;
		}
		child.kill(undefined, 1_000);
		await child.exited.catch(() => {});
		this.#rejectPending(new Error("OMP RPC transport stopped."));
		this.#pendingApprovals.clear();
		this.#acceptedPromptRequestIds.clear();
		this.#pendingPromptResults.clear();
		this.#clearAssistantSources();
		this.#toolArgumentsByCallId.clear();
		this.#notifyExit({ expected: true });
	}

	async #readOutput(child: ptree.ChildProcess<"pipe">, onFrame: (frame: unknown) => void): Promise<void> {
		const decoder = new RpcFrameDecoder();
		for await (const line of readJsonl<unknown>(child.stdout)) {
			if (isRecord(line) && line.type === "rpc_chunk" && !this.#protocolV2Enabled) {
				throw new Error("OMP RPC sent a chunk before protocol v2 negotiation.");
			}
			const frame = decoder.push(line);
			if (frame) onFrame(frame);
		}
		if (!this.#expectedStop) throw new Error("OMP RPC output stream ended unexpectedly.");
	}

	#handleFrame(frame: unknown): void {
		if (isRpcResponse(frame) && typeof frame.id === "string") {
			const pending = this.#pendingRequests.get(frame.id);
			if (pending) {
				this.#pendingRequests.delete(frame.id);
				clearTimeout(pending.timeout);
				if (pending.command === "prompt" && frame.command === "prompt" && frame.success) {
					this.#acceptedPromptRequestIds.add(frame.id);
					const earlyResult = this.#pendingPromptResults.get(frame.id);
					this.#pendingPromptResults.delete(frame.id);
					const result = localOnlyPromptResult(frame) ?? earlyResult;
					if (result) this.#reportPromptResult(frame.id, result);
				}
				pending.resolve(frame);
				return;
			}
			if (frame.command === "prompt" && !frame.success && this.#acceptedPromptRequestIds.delete(frame.id)) {
				this.#pendingPromptResults.delete(frame.id);
				this.#notifyPromptFailure();
				return;
			}
		}
		if (isRpcPromptResultFrame(frame)) {
			if (typeof frame.id !== "string" || frame.agentInvoked) return;
			const result: StudioRpcPromptResult = { agentInvoked: false };
			if (this.#acceptedPromptRequestIds.has(frame.id)) {
				this.#reportPromptResult(frame.id, result);
			} else if (this.#pendingRequests.get(frame.id)?.command === "prompt") {
				this.#rememberEarlyPromptResult(frame.id, result);
			}
			return;
		}
		if (isStudioApprovalRequest(frame)) {
			const request = createStudioApprovalRequest(
				{
					requestId: frame.id,
					toolCallId: frame.toolCallId,
					toolName: frame.toolName,
					...(typeof frame.reason === "string" && frame.reason ? { reason: frame.reason } : {}),
				},
				this.#toolArgumentsByCallId.get(frame.toolCallId),
			);
			this.#trackPendingApproval(request);
			for (const listener of this.#approvalListeners) listener(request);
			return;
		}
		if (isRecord(frame) && frame.type === "extension_ui_request" && typeof frame.id === "string") {
			void this.#writeFrame({
				type: "extension_ui_response",
				id: frame.id,
				cancelled: true,
			} satisfies RpcExtensionUIResponse).catch(() => {});
			return;
		}
		if (isSubagentFrame(frame)) {
			const subagent = toStudioSubagent(frame);
			if (subagent) {
				for (const listener of this.#subagentListeners) listener(subagent);
			}
			return;
		}
		if (!isSessionEvent(frame)) return;
		if (frame.type === "agent_start") this.#clearAssistantSources();
		if (isAssistantMessageError(frame)) this.#terminalAssistantError = true;
		this.#emitTranscriptUpdate(frame);
		if (frame.type === "tool_execution_start" && typeof frame.toolCallId === "string") {
			this.#trackToolArguments(frame.toolCallId, frame.args);
		}
		const event = redactStudioAgentEvent(frame);
		const planSummary = extractStudioPlanSummary(frame);
		if (planSummary) {
			for (const listener of this.#planListeners) listener(planSummary);
		}
		if (frame.type === "agent_end" && frame.isTerminal !== false && this.#terminalAssistantError) {
			event.isError = true;
		}
		for (const listener of this.#eventListeners) listener(event);
		if (frame.type === "tool_execution_end" && typeof frame.toolCallId === "string") {
			this.#toolArgumentsByCallId.delete(frame.toolCallId);
		}
		if (frame.type === "agent_end" && frame.isTerminal !== false) {
			this.#acceptedPromptRequestIds.clear();
			this.#pendingPromptResults.clear();
			this.#clearAssistantSources();
			this.#toolArgumentsByCallId.clear();
			this.#cancelPendingApprovals();
		}
	}

	#emitTranscriptUpdate(frame: Record<string, unknown>): void {
		const text = extractStudioAssistantTranscriptText(frame);
		const message = frame.message;
		if (!isRecord(message)) return;
		const failed = isAssistantMessageError(frame);
		if (text === undefined && !failed) return;
		const sourceId = this.#sourceIdForAssistantMessage(message);
		const update: StudioRpcTranscriptUpdate = {
			sourceId,
			status: failed ? "failed" : frame.type === "message_end" ? "completed" : "streaming",
			text: text ?? "",
		};
		for (const listener of this.#transcriptListeners) listener(update);
		if (frame.type === "message_end") this.#currentAssistantSourceId = undefined;
	}

	#sourceIdForAssistantMessage(message: Record<string, unknown>): string {
		const keys = studioAssistantMessageKeys(message);
		const existing =
			keys.map(key => this.#assistantSourceIds.get(key)).find(Boolean) ?? this.#currentAssistantSourceId;
		if (existing) {
			for (const key of keys) this.#assistantSourceIds.set(key, existing);
			this.#currentAssistantSourceId = existing;
			return existing;
		}
		const sourceId = `assistant_${++this.#nextAssistantSourceId}`;
		for (const key of keys) this.#assistantSourceIds.set(key, sourceId);
		this.#currentAssistantSourceId = sourceId;
		return sourceId;
	}

	#clearAssistantSources(): void {
		this.#assistantSourceIds.clear();
		this.#currentAssistantSourceId = undefined;
		this.#terminalAssistantError = false;
	}

	#notifyPromptFailure(): void {
		for (const listener of this.#promptFailureListeners) listener();
	}

	#notifyPromptResult(result: StudioRpcPromptResult): void {
		for (const listener of this.#promptResultListeners) listener(result);
	}

	#reportPromptResult(requestId: string, result: StudioRpcPromptResult): void {
		if (!this.#acceptedPromptRequestIds.delete(requestId)) return;
		this.#notifyPromptResult(result);
	}

	#rememberEarlyPromptResult(requestId: string, result: StudioRpcPromptResult): void {
		this.#pendingPromptResults.delete(requestId);
		this.#pendingPromptResults.set(requestId, result);
		while (this.#pendingPromptResults.size > MAX_TRACKED_TOOL_CALLS) {
			const oldest = this.#pendingPromptResults.keys().next();
			if (oldest.done) break;
			this.#pendingPromptResults.delete(oldest.value);
		}
	}

	#cancelPendingApprovals(): void {
		for (const requestId of this.#pendingApprovals.keys()) {
			void this.#writeFrame({
				type: "extension_ui_response",
				id: requestId,
				cancelled: true,
			} satisfies RpcExtensionUIResponse).catch(() => {});
		}
		this.#pendingApprovals.clear();
	}

	#notifyExit(exit: StudioRpcTransportExit): void {
		if (this.#exit) return;
		this.#exit = exit;
		this.#acceptedPromptRequestIds.clear();
		this.#pendingPromptResults.clear();
		this.#clearAssistantSources();
		this.#pendingApprovals.clear();
		this.#toolArgumentsByCallId.clear();
		for (const listener of this.#exitListeners) listener(exit);
		this.#exitListeners.clear();
	}

	#rejectPending(error: Error): void {
		for (const [id, pending] of this.#pendingRequests) {
			this.#pendingRequests.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
	}

	#trackPendingApproval(request: StudioRpcApprovalRequest): void {
		this.#pendingApprovals.delete(request.requestId);
		this.#pendingApprovals.set(request.requestId, request);
		while (this.#pendingApprovals.size > MAX_TRACKED_TOOL_CALLS) {
			const oldest = this.#pendingApprovals.keys().next();
			if (oldest.done) break;
			this.#pendingApprovals.delete(oldest.value);
			void this.#writeFrame({
				type: "extension_ui_response",
				id: oldest.value,
				cancelled: true,
			} satisfies RpcExtensionUIResponse).catch(() => {});
		}
	}

	#trackToolArguments(toolCallId: string, argumentsValue: unknown): void {
		this.#toolArgumentsByCallId.delete(toolCallId);
		this.#toolArgumentsByCallId.set(toolCallId, argumentsValue);
		while (this.#toolArgumentsByCallId.size > MAX_TRACKED_TOOL_CALLS) {
			const oldest = this.#toolArgumentsByCallId.keys().next();
			if (oldest.done) break;
			this.#toolArgumentsByCallId.delete(oldest.value);
		}
	}

	#send(command: StudioRpcCommand): Promise<RpcResponse> {
		if (!this.#child || this.#exit) throw new Error("OMP RPC transport is not running.");
		const id = `studio_req_${++this.#requestId}`;
		const frame: RpcCommand = { ...command, id };
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		const timeout = setTimeout(() => {
			this.#pendingRequests.delete(id);
			reject(new Error("OMP RPC command timed out."));
		}, RPC_START_TIMEOUT_MS);
		timeout.unref();
		this.#pendingRequests.set(id, { command: command.type, resolve, reject, timeout });
		void this.#writeFrame(frame).catch(error => {
			const pending = this.#pendingRequests.get(id);
			if (!pending) return;
			this.#pendingRequests.delete(id);
			clearTimeout(pending.timeout);
			pending.reject(error instanceof Error ? error : new Error("OMP RPC write failed."));
		});
		return promise;
	}

	async #writeFrame(frame: RpcCommand | RpcExtensionUIResponse): Promise<void> {
		const child = this.#child;
		if (!child?.stdin) throw new Error("OMP RPC transport is not running.");
		const stdin = child.stdin as FileSink;
		stdin.write(`${JSON.stringify(frame)}\n`);
		const flushResult = stdin.flush();
		if (isPromise(flushResult)) await flushResult;
	}
}

/** Create a transport factory that follows the current CLI executable into an OMP RPC child. */
export function createStudioRpcTransportFactory(): StudioRpcTransportFactory {
	return {
		start: async launch => {
			const transport = new CodingAgentStudioRpcTransport(launch);
			await transport.start();
			return transport;
		},
	};
}
