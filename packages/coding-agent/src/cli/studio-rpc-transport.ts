import { isPromise } from "node:util/types";
import type {
	StudioRpcAgentEvent,
	StudioRpcApprovalRequest,
	StudioRpcLaunch,
	StudioRpcSessionState,
	StudioRpcTransport,
	StudioRpcTransportExit,
	StudioRpcTransportFactory,
	StudioRpcUsage,
	StudioSubagent,
} from "@oh-my-pi/omp-studio";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder } from "../modes/rpc/rpc-frame";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "../modes/rpc/rpc-types";
import { resolveOmpCommandInvocation } from "../task/omp-command";

const RPC_START_TIMEOUT_MS = 30_000;
const MAX_TRACKED_TOOL_CALLS = 256;
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

/** Redact a native OMP event before it crosses into Studio's browser protocol. */
export function redactStudioAgentEvent(event: Record<string, unknown>): StudioRpcAgentEvent {
	const base: StudioRpcAgentEvent = { type: event.type as string };
	if (typeof event.isTerminal === "boolean") base.isTerminal = event.isTerminal;
	if (typeof event.isError === "boolean") base.isError = event.isError;
	if (typeof event.toolCallId === "string") base.toolCallId = event.toolCallId;
	if (typeof event.toolName === "string") base.toolName = event.toolName;
	return base;
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

/** Coding-agent implementation of Studio's server-only child-process transport. */
class CodingAgentStudioRpcTransport implements StudioRpcTransport {
	#approvalListeners = new Set<(request: StudioRpcApprovalRequest) => void>();
	#child: ptree.ChildProcess<"pipe"> | undefined;
	#eventListeners = new Set<(event: StudioRpcAgentEvent) => void>();
	#exit: StudioRpcTransportExit | undefined;
	#exitListeners = new Set<(exit: StudioRpcTransportExit) => void>();
	#expectedStop = false;
	#pendingApprovals = new Map<string, StudioRpcApprovalRequest>();
	#pendingRequests = new Map<string, PendingRequest>();
	#protocolVersion = 1;
	#protocolV2Enabled = false;
	#requestId = 0;
	#subagentListeners = new Set<(subagent: StudioSubagent) => void>();
	#toolArgumentsByCallId = new Map<string, unknown>();

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
			{ cwd: this.launch.cwd, stdin: "pipe" },
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

	onSubagentState(listener: (subagent: StudioSubagent) => void): () => void {
		this.#subagentListeners.add(listener);
		return () => this.#subagentListeners.delete(listener);
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
				pending.resolve(frame);
				return;
			}
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
		if (frame.type === "tool_execution_start" && typeof frame.toolCallId === "string") {
			this.#trackToolArguments(frame.toolCallId, frame.args);
		}
		const event = redactStudioAgentEvent(frame);
		for (const listener of this.#eventListeners) listener(event);
		if (frame.type === "tool_execution_end" && typeof frame.toolCallId === "string") {
			this.#toolArgumentsByCallId.delete(frame.toolCallId);
		}
		if (frame.type === "agent_end" && frame.isTerminal !== false) {
			this.#toolArgumentsByCallId.clear();
			this.#cancelPendingApprovals();
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
		this.#pendingRequests.set(id, { resolve, reject, timeout });
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
