import { logger } from "@oh-my-pi/pi-utils";
import type {
	StudioActivityEntry,
	StudioAgentEvent,
	StudioApproval,
	StudioModelSelection,
	StudioPlanSummary,
	StudioRun,
	StudioSession,
	StudioSubagent,
	StudioToolDisplay,
	StudioToolDisplayStatus,
	StudioTranscriptMessage,
	StudioUsage,
} from "../protocol";
import { projectStudioActivityEvent, projectStudioToolDisplayKind } from "./activity-projection";
import type { CreateStudioRunResult, StudioStore } from "./studio-store";

const APPROVAL_EXPIRY_MS = 5 * 60_000;
const STUDIO_APPROVAL_REASON = "OMP requires confirmation for this tool.";
const INITIAL_ASSISTANT_TRANSCRIPT_SOURCE_ID = "assistant_initial";
const STUDIO_TRANSCRIPT_UPDATE_INTERVAL_MS = 50;

export type StudioRpcSupervisorErrorCode =
	| "rpc_supervisor_unavailable"
	| "studio_session_not_found"
	| "studio_session_model_missing"
	| "studio_workspace_not_found"
	| "rpc_start_failed"
	| "run_active"
	| "run_not_found"
	| "run_not_active"
	| "rpc_prompt_failed"
	| "rpc_cancel_failed"
	| "approval_not_found"
	| "approval_not_active"
	| "approval_expired"
	| "approval_transport_unavailable";

/** A known-safe supervisor failure that can be returned through the Studio API. */
export class StudioRpcSupervisorError extends Error {
	constructor(
		readonly code: StudioRpcSupervisorErrorCode,
		message: string,
	) {
		super(message);
		this.name = "StudioRpcSupervisorError";
	}
}

/** Server-only launch data. The browser never sees a workspace or OMP session path. */
export interface StudioRpcLaunch {
	cwd: string;
	model: StudioModelSelection;
	profile: string;
	sessionRef?: string;
}

/** The durable identifiers recovered from a successfully started OMP RPC child. */
export interface StudioRpcSessionState {
	ompSessionId: string;
	ompSessionRef?: string;
}

/**
 * Server-only OMP event metadata retained long enough to project a fixed
 * activity subject. It must never be returned through the browser protocol.
 */
export interface StudioRpcAgentEvent {
	type: string;
	isError?: boolean;
	isTerminal?: boolean;
	toolCallId?: string;
	toolName?: string;
}

/** One native OMP approval request waiting for a Studio browser decision. */
export interface StudioRpcApprovalRequest {
	requestId: string;
	toolCallId: string;
	toolName: string;
	argumentsDigest: string;
	reason?: string;
}

export type StudioRpcUsage = Omit<StudioUsage, "updatedAtMs">;

/** Server-only aggregate extracted from a native todo result. Task text never reaches this shape. */
export type StudioRpcPlanSummary = Omit<StudioPlanSummary, "studioSessionId" | "runId" | "updatedAtMs">;

export interface StudioRpcTransportExit {
	expected: boolean;
}

/** The safe outcome reported when an accepted RPC prompt did not start the agent. */
export interface StudioRpcPromptResult {
	agentInvoked: boolean;
}

/** A text-only assistant snapshot produced by the server-side OMP transport. */
export interface StudioRpcTranscriptUpdate {
	sourceId: string;
	status: "streaming" | "completed" | "failed";
	text: string;
}

/**
 * Implemented by coding-agent. Studio owns lifecycle decisions while the host
 * owns child-process spawning, RPC framing, and OMP-specific transport details.
 */
export interface StudioRpcTransport {
	readonly protocolVersion: number;
	abort(): Promise<void>;
	getSessionState(): Promise<StudioRpcSessionState>;
	getUsage?(): Promise<StudioRpcUsage>;
	onApprovalRequest?(listener: (request: StudioRpcApprovalRequest) => void): () => void;
	onEvent(listener: (event: StudioRpcAgentEvent) => void): () => void;
	onExit(listener: (exit: StudioRpcTransportExit) => void): () => void;
	onPromptFailure?(listener: () => void): () => void;
	onPromptResult?(listener: (result: StudioRpcPromptResult) => void): () => void;
	onSubagentState?(listener: (subagent: StudioSubagent) => void): () => void;
	onPlanSummary?(listener: (summary: StudioRpcPlanSummary) => void): () => void;
	onTranscriptUpdate?(listener: (update: StudioRpcTranscriptUpdate) => void): () => void;
	prompt(message: string): Promise<void>;
	resolveApproval?(requestId: string, approved: boolean): Promise<void>;
	stop(): Promise<void>;
}

export interface StudioRpcTransportFactory {
	start(launch: StudioRpcLaunch): Promise<StudioRpcTransport>;
}

export interface StudioRpcSupervisorEvents {
	onActivityUpdated(studioSessionId: string, entry: StudioActivityEntry): void;
	onAgentEvent(studioSessionId: string, runId: string, event: StudioAgentEvent): void;
	onPlanSummaryUpdated(studioSessionId: string, plan: StudioPlanSummary): void;
	onApprovalRequested(studioSessionId: string, approval: StudioApproval): void;
	onApprovalResolved(studioSessionId: string, approval: StudioApproval): void;
	onRunState(session: StudioSession, run: StudioRun): void;
	onSubagentState(studioSessionId: string, subagent: StudioSubagent): void;
	onToolDisplayUpdated(studioSessionId: string, display: StudioToolDisplay): void;
	onTranscriptUpdated(studioSessionId: string, message: StudioTranscriptMessage): void;
	onUsageUpdated(session: StudioSession, usage: StudioUsage): void;
}

interface ActiveStudioRpcSession {
	awaitingPromptAcceptance: PendingStudioPrompt | undefined;
	onApprovalRequest: () => void;
	onEvent: () => void;
	onExit: () => void;
	onPromptFailure: () => void;
	onPromptResult: () => void;
	onSubagentState: () => void;
	onPlanSummary: () => void;
	onTranscriptUpdate: () => void;
	transport: StudioRpcTransport;
}

interface PendingStudioPrompt {
	promptFailure: boolean;
	promptResult: StudioRpcPromptResult | undefined;
	runId: string;
	transcriptUpdates: StudioRpcTranscriptUpdate[];
}

interface PendingStudioTranscriptUpdate {
	runId: string;
	studioSessionId: string;
	update: StudioRpcTranscriptUpdate;
}

interface PendingStudioApproval {
	argumentsDigest: string;
	runId: string;
	studioSessionId: string;
	transport: StudioRpcTransport;
	transportRequestId: string;
}

function isTerminalAgentEnd(event: StudioRpcAgentEvent): boolean {
	return event.type === "agent_end" && event.isTerminal !== false;
}

function isAgentStart(event: StudioRpcAgentEvent): boolean {
	return event.type === "agent_start";
}

function toStudioAgentEvent(event: StudioRpcAgentEvent): StudioAgentEvent {
	return {
		type: event.type,
		...(event.isError === undefined ? {} : { isError: event.isError }),
		...(event.isTerminal === undefined ? {} : { isTerminal: event.isTerminal }),
	};
}

/**
 * Coordinates persistent Studio session/run state with one OMP RPC child per
 * active Studio session. It has no coding-agent dependency so its transport can
 * be supplied by the CLI host or replaced by an in-memory test double.
 */
export class StudioRpcSupervisor {
	#activeSessions = new Map<string, ActiveStudioRpcSession>();
	#approvalExpiryTimers = new Map<string, Timer>();
	#closed = false;
	#events: StudioRpcSupervisorEvents;
	#pendingApprovals = new Map<string, PendingStudioApproval>();
	#pendingTranscriptUpdates = new Map<string, PendingStudioTranscriptUpdate>();
	#startingSessions = new Map<string, Promise<StudioSession>>();
	#store: StudioStore;
	#subagentsBySession = new Map<string, Map<string, StudioSubagent>>();
	#toolDisplayIdsByRun = new Map<string, Map<string, string>>();
	#transcriptSourceIdsByRun = new Map<string, Map<string, string>>();
	#transcriptUpdateTimers = new Map<string, Timer>();
	#transportFactory: StudioRpcTransportFactory | undefined;
	#usageRefreshInFlight = new Set<string>();

	constructor(store: StudioStore, events: StudioRpcSupervisorEvents, transportFactory?: StudioRpcTransportFactory) {
		this.#store = store;
		this.#events = events;
		this.#transportFactory = transportFactory;
	}

	get enabled(): boolean {
		return this.#transportFactory !== undefined;
	}

	async startSession(studioSessionId: string): Promise<StudioSession> {
		if (this.#closed) {
			throw new StudioRpcSupervisorError(
				"rpc_start_failed",
				"Studio is shutting down and cannot start an OMP session.",
			);
		}
		if (!this.#transportFactory) {
			throw new StudioRpcSupervisorError(
				"rpc_supervisor_unavailable",
				"OMP RPC supervision is unavailable in this Studio host.",
			);
		}
		const active = this.#activeSessions.get(studioSessionId);
		if (active) {
			const session = this.#store.getStudioSession(studioSessionId);
			if (!session)
				throw new StudioRpcSupervisorError(
					"studio_session_not_found",
					"The requested Studio session was not found.",
				);
			return session;
		}
		const starting = this.#startingSessions.get(studioSessionId);
		if (starting) return await starting;

		const start = this.#startSession(studioSessionId);
		this.#startingSessions.set(studioSessionId, start);
		try {
			return await start;
		} finally {
			if (this.#startingSessions.get(studioSessionId) === start) this.#startingSessions.delete(studioSessionId);
		}
	}

	async prompt(studioSessionId: string, message: string): Promise<{ run: StudioRun; session: StudioSession }> {
		const session = await this.startSession(studioSessionId);
		const active = this.#activeSessions.get(studioSessionId);
		if (!active) {
			throw new StudioRpcSupervisorError("rpc_start_failed", "OMP Studio could not start the requested session.");
		}

		const created = this.#store.createStudioRun(studioSessionId, active.transport.protocolVersion);
		if (created.kind === "active") {
			throw new StudioRpcSupervisorError("run_active", "The Studio session already has an active run.");
		}
		this.#subagentsBySession.delete(studioSessionId);
		const startingSession = this.#store.getStudioSession(studioSessionId) ?? session;
		this.#events.onRunState(startingSession, created.run);
		this.#store.appendAuditEntry({
			action: "run_started",
			studioSessionId,
			runId: created.run.id,
			detail: { rpcProtocolVersion: active.transport.protocolVersion },
		});

		const awaitingPromptAcceptance: PendingStudioPrompt = {
			promptFailure: false,
			promptResult: undefined,
			runId: created.run.id,
			transcriptUpdates: [],
		};
		active.awaitingPromptAcceptance = awaitingPromptAcceptance;
		try {
			await active.transport.prompt(message);
			if (this.#activeSessions.get(studioSessionId) !== active) {
				throw new Error("OMP RPC process exited while accepting the prompt.");
			}
			const userMessage = this.#store.createStudioUserTranscriptMessage({
				studioSessionId,
				runId: created.run.id,
				text: message,
			});
			if (!userMessage) throw new Error("Studio could not persist the accepted prompt.");
			this.#events.onTranscriptUpdated(studioSessionId, userMessage);
			const assistantMessage = this.#store.upsertStudioAssistantTranscriptMessage({
				studioSessionId,
				runId: created.run.id,
				sourceId: INITIAL_ASSISTANT_TRANSCRIPT_SOURCE_ID,
				status: "streaming",
				text: "",
			});
			if (!assistantMessage) throw new Error("Studio could not initialize the assistant transcript.");
			this.#events.onTranscriptUpdated(studioSessionId, assistantMessage);
			const running = this.#markRunRunning(created);
			if (active.awaitingPromptAcceptance === awaitingPromptAcceptance) {
				active.awaitingPromptAcceptance = undefined;
			}
			for (const update of awaitingPromptAcceptance.transcriptUpdates) {
				this.#queueTranscriptUpdate(studioSessionId, created.run.id, update);
			}
			if (awaitingPromptAcceptance.promptFailure) {
				this.#handlePromptFailure(studioSessionId, active);
			} else if (awaitingPromptAcceptance.promptResult?.agentInvoked === false) {
				this.#handlePromptResult(studioSessionId, active, awaitingPromptAcceptance.promptResult);
			}
			this.#finishTranscriptForTerminalRun(created.run.id);
			return {
				run: this.#store.getStudioRun(created.run.id) ?? running,
				session: this.#store.getStudioSession(studioSessionId) ?? startingSession,
			};
		} catch {
			if (active.awaitingPromptAcceptance === awaitingPromptAcceptance) {
				active.awaitingPromptAcceptance = undefined;
			}
			const current = this.#store.getStudioRun(created.run.id);
			if (current && ["starting", "running", "cancelling"].includes(current.status)) {
				const failed = this.#store.finishStudioRun(created.run.id, "failed", "rpc_prompt_failed");
				this.#emitToolDisplayTerminalUpdates(created.run.id, "failed");
				this.#finishTranscriptMessages(created.run.id, "failed");
				const readySession = this.#store.updateStudioSessionRuntime(studioSessionId, { status: "ready" });
				if (failed && readySession) this.#events.onRunState(readySession, failed);
				this.#store.appendAuditEntry({
					action: "run_failed",
					studioSessionId,
					runId: created.run.id,
					detail: { reason: "rpc_prompt_failed" },
				});
			}
			throw new StudioRpcSupervisorError("rpc_prompt_failed", "OMP could not accept the prompt.");
		}
	}

	getSubagents(studioSessionId: string): StudioSubagent[] {
		return [...(this.#subagentsBySession.get(studioSessionId)?.values() ?? [])].sort(
			(left, right) => left.index - right.index || left.id.localeCompare(right.id),
		);
	}

	async reconcileExpiredApprovals(studioSessionId: string): Promise<void> {
		const approvals = this.#store.listStudioApprovals(studioSessionId);
		for (const approval of approvals) {
			if (approval.status !== "expired" || !this.#pendingApprovals.has(approval.id)) continue;
			await this.#expireApproval(approval.id);
		}
	}

	async resolveApproval(approvalId: string, approved: boolean): Promise<StudioApproval> {
		this.#clearApprovalExpiry(approvalId);
		const approval = this.#store.getStudioApproval(approvalId);
		if (!approval) {
			throw new StudioRpcSupervisorError("approval_not_found", "The requested Studio approval was not found.");
		}
		if (approval.status === "expired" || approval.expiresAtMs <= Date.now()) {
			const expired = this.#store.resolveStudioApproval(approvalId, "rejected", "approval expired");
			const expiredApproval = expired.kind === "expired" ? expired.approval : approval;
			const pending = this.#pendingApprovals.get(approvalId);
			this.#pendingApprovals.delete(approvalId);
			if (pending?.transport.resolveApproval) {
				void pending.transport.resolveApproval(pending.transportRequestId, false).catch(() => {});
			}
			this.#events.onApprovalResolved(expiredApproval.studioSessionId, expiredApproval);
			this.#store.appendAuditEntry({
				action: "approval_expired",
				studioSessionId: expiredApproval.studioSessionId,
				runId: expiredApproval.runId,
				detail: { approvalId: expiredApproval.id, toolName: expiredApproval.toolName },
			});
			throw new StudioRpcSupervisorError("approval_expired", "The requested Studio approval has expired.");
		}
		if (approval.status !== "pending") {
			throw new StudioRpcSupervisorError(
				"approval_not_active",
				"The requested Studio approval is no longer pending.",
			);
		}
		const pending = this.#pendingApprovals.get(approvalId);
		if (
			!pending ||
			pending.runId !== approval.runId ||
			pending.studioSessionId !== approval.studioSessionId ||
			pending.argumentsDigest !== approval.argumentsDigest
		) {
			this.#scheduleApprovalExpiry(approval);
			throw new StudioRpcSupervisorError(
				"approval_not_active",
				"The requested Studio approval is no longer connected to the active OMP tool call.",
			);
		}
		if (!pending.transport.resolveApproval) {
			this.#scheduleApprovalExpiry(approval);
			throw new StudioRpcSupervisorError(
				"approval_transport_unavailable",
				"The active OMP transport cannot resolve Studio tool approvals.",
			);
		}

		this.#pendingApprovals.delete(approvalId);
		try {
			await pending.transport.resolveApproval(pending.transportRequestId, approved);
		} catch {
			this.#pendingApprovals.set(approvalId, pending);
			this.#scheduleApprovalExpiry(approval);
			throw new StudioRpcSupervisorError(
				"approval_transport_unavailable",
				"OMP could not receive the Studio approval decision.",
			);
		}
		const resolved = this.#store.resolveStudioApproval(
			approvalId,
			approved ? "approved" : "rejected",
			approved ? "approved by local controller" : "rejected by local controller",
		);
		if (resolved.kind !== "resolved") {
			throw new StudioRpcSupervisorError(
				"approval_not_active",
				"The requested Studio approval changed while the decision was being delivered.",
			);
		}
		this.#events.onApprovalResolved(resolved.approval.studioSessionId, resolved.approval);
		this.#store.appendAuditEntry({
			action: approved ? "approval_approved" : "approval_rejected",
			studioSessionId: resolved.approval.studioSessionId,
			runId: resolved.approval.runId,
			detail: { approvalId: resolved.approval.id, toolName: resolved.approval.toolName },
		});
		return resolved.approval;
	}

	async cancelRun(runId: string): Promise<StudioRun> {
		const run = this.#store.getStudioRun(runId);
		if (!run) throw new StudioRpcSupervisorError("run_not_found", "The requested Studio run was not found.");
		if (!["starting", "running", "cancelling"].includes(run.status)) {
			throw new StudioRpcSupervisorError("run_not_active", "The requested Studio run is no longer active.");
		}
		const active = this.#activeSessions.get(run.studioSessionId);
		if (!active) {
			throw new StudioRpcSupervisorError(
				"run_not_active",
				"The requested Studio run is no longer connected to OMP.",
			);
		}

		const cancelling = this.#store.markStudioRunCancelling(run.id) ?? run;
		const session = this.#store.getStudioSession(run.studioSessionId);
		if (session) this.#events.onRunState(session, cancelling);
		try {
			this.#interruptRunApprovals(run.id, "run_cancel_requested");
			await active.transport.abort();
			this.#store.appendAuditEntry({
				action: "run_cancel_requested",
				studioSessionId: run.studioSessionId,
				runId: run.id,
				detail: {},
			});
			return cancelling;
		} catch {
			throw new StudioRpcSupervisorError("rpc_cancel_failed", "OMP could not cancel the active run.");
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#flushPendingTranscriptUpdates();
		for (const [studioSessionId, active] of this.#activeSessions) {
			const activeRun = this.#store.getStudioSession(studioSessionId)?.activeRun;
			if (activeRun) this.#interruptRunApprovals(activeRun.id, "studio_shutdown");
			active.onApprovalRequest();
			active.onEvent();
			active.onExit();
			active.onPromptFailure();
			active.onPromptResult();
			active.onSubagentState();
			active.onPlanSummary();
			active.onTranscriptUpdate();
			this.#activeSessions.delete(studioSessionId);
			void active.transport.stop();
		}
		this.#pendingApprovals.clear();
		this.#clearApprovalExpiryTimers();
		this.#subagentsBySession.clear();
		this.#toolDisplayIdsByRun.clear();
		this.#transcriptSourceIdsByRun.clear();
		this.#store.interruptActiveRuntime("studio_shutdown");
	}

	async #startSession(studioSessionId: string): Promise<StudioSession> {
		const factory = this.#transportFactory;
		if (!factory) {
			throw new StudioRpcSupervisorError(
				"rpc_supervisor_unavailable",
				"OMP RPC supervision is unavailable in this Studio host.",
			);
		}
		const stored = this.#store.getStoredStudioSession(studioSessionId);
		if (!stored) {
			throw new StudioRpcSupervisorError("studio_session_not_found", "The requested Studio session was not found.");
		}
		const model = stored.session.model;
		if (!model) {
			throw new StudioRpcSupervisorError(
				"studio_session_model_missing",
				"The Studio session does not have a selected OMP model.",
			);
		}
		const cwd = this.#store.getWorkspaceCanonicalPath(stored.session.workspaceId);
		if (!cwd) {
			throw new StudioRpcSupervisorError(
				"studio_workspace_not_found",
				"The Studio session workspace is no longer registered.",
			);
		}

		this.#store.updateStudioSessionRuntime(studioSessionId, { status: "starting" });
		let transport: StudioRpcTransport | undefined;
		try {
			transport = await factory.start({
				cwd,
				model,
				profile: stored.session.profile,
				...(stored.ompSessionRef ? { sessionRef: stored.ompSessionRef } : {}),
			});
			if (transport.protocolVersion !== 2) {
				await transport.stop();
				throw new Error("OMP RPC protocol v2 was not negotiated.");
			}
			const runtimeState = await transport.getSessionState();
			if (!runtimeState.ompSessionId) throw new Error("OMP RPC session state did not include a session ID.");
			const active: ActiveStudioRpcSession = {
				awaitingPromptAcceptance: undefined,
				onApprovalRequest: () => {},
				onEvent: () => {},
				onExit: () => {},
				onPromptFailure: () => {},
				onPromptResult: () => {},
				onSubagentState: () => {},
				onPlanSummary: () => {},
				onTranscriptUpdate: () => {},
				transport,
			};
			this.#activeSessions.set(studioSessionId, active);
			active.onEvent = transport.onEvent(event => this.#handleAgentEvent(studioSessionId, event));
			active.onExit = transport.onExit(exit => this.#handleTransportExit(studioSessionId, active, exit));
			active.onPromptFailure =
				transport.onPromptFailure?.(() => this.#handlePromptFailure(studioSessionId, active)) ?? (() => {});
			active.onPromptResult =
				transport.onPromptResult?.(result => this.#handlePromptResult(studioSessionId, active, result)) ??
				(() => {});
			active.onApprovalRequest =
				transport.onApprovalRequest?.(request => this.#handleApprovalRequest(studioSessionId, active, request)) ??
				(() => {});
			active.onSubagentState =
				transport.onSubagentState?.(subagent => this.#handleSubagentState(studioSessionId, subagent)) ?? (() => {});
			active.onPlanSummary =
				transport.onPlanSummary?.(summary => this.#handlePlanSummary(studioSessionId, active, summary)) ??
				(() => {});
			active.onTranscriptUpdate =
				transport.onTranscriptUpdate?.(update => this.#handleTranscriptUpdate(studioSessionId, active, update)) ??
				(() => {});
			if (this.#activeSessions.get(studioSessionId) !== active) {
				throw new Error("OMP RPC process exited while Studio was starting the session.");
			}
			const session = this.#store.updateStudioSessionRuntime(studioSessionId, {
				status: "ready",
				ompSessionId: runtimeState.ompSessionId,
				...(runtimeState.ompSessionRef ? { ompSessionRef: runtimeState.ompSessionRef } : {}),
			});
			if (!session) throw new Error("Studio session disappeared while OMP was starting.");
			this.#store.appendAuditEntry({
				action: stored.ompSessionRef ? "session_resumed" : "session_started",
				studioSessionId,
				detail: { rpcProtocolVersion: transport.protocolVersion },
			});
			return session;
		} catch (error) {
			if (transport) await transport.stop().catch(() => {});
			if (this.#store.getStudioSession(studioSessionId)?.status !== "interrupted") {
				this.#store.updateStudioSessionRuntime(studioSessionId, { status: "failed" });
			}
			this.#store.appendAuditEntry({
				action: "session_start_failed",
				studioSessionId,
				detail: {},
			});
			if (error instanceof StudioRpcSupervisorError) throw error;
			throw new StudioRpcSupervisorError("rpc_start_failed", "OMP Studio could not start the requested session.");
		}
	}

	#markRunRunning(created: Extract<CreateStudioRunResult, { kind: "created" }>): StudioRun {
		const current = this.#store.getStudioRun(created.run.id);
		if (current?.status !== "starting") return current ?? created.run;
		const running = this.#store.markStudioRunRunning(created.run.id) ?? current;
		const session = this.#store.getStudioSession(created.run.studioSessionId);
		if (session) this.#events.onRunState(session, running);
		return running;
	}

	#handleApprovalRequest(
		studioSessionId: string,
		active: ActiveStudioRpcSession,
		request: StudioRpcApprovalRequest,
	): void {
		const reject = (): void => {
			if (!active.transport.resolveApproval) return;
			void active.transport.resolveApproval(request.requestId, false).catch(() => {});
		};
		if (this.#closed || this.#activeSessions.get(studioSessionId) !== active) {
			reject();
			return;
		}
		const run = this.#store.getStudioSession(studioSessionId)?.activeRun;
		if (!run) {
			reject();
			return;
		}
		const approval = this.#store.createStudioApproval({
			runId: run.id,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			argumentsDigest: request.argumentsDigest,
			...(request.reason ? { reason: STUDIO_APPROVAL_REASON } : {}),
			expiresAtMs: Date.now() + APPROVAL_EXPIRY_MS,
		});
		if (!approval) {
			reject();
			return;
		}
		this.#pendingApprovals.set(approval.id, {
			argumentsDigest: request.argumentsDigest,
			runId: run.id,
			studioSessionId,
			transport: active.transport,
			transportRequestId: request.requestId,
		});
		this.#scheduleApprovalExpiry(approval);
		this.#events.onApprovalRequested(studioSessionId, approval);
		this.#store.appendAuditEntry({
			action: "approval_requested",
			studioSessionId,
			runId: run.id,
			detail: { approvalId: approval.id, argumentsDigest: approval.argumentsDigest, toolName: approval.toolName },
		});
	}

	#interruptRunApprovals(runId: string, reason: string): void {
		const approvals = this.#store.interruptStudioRunApprovals(runId, reason);
		for (const approval of approvals) {
			this.#clearApprovalExpiry(approval.id);
			const pending = this.#pendingApprovals.get(approval.id);
			this.#pendingApprovals.delete(approval.id);
			if (pending?.transport.resolveApproval) {
				void pending.transport.resolveApproval(pending.transportRequestId, false).catch(() => {});
			}
			this.#events.onApprovalResolved(approval.studioSessionId, approval);
			this.#store.appendAuditEntry({
				action: "approval_interrupted",
				studioSessionId: approval.studioSessionId,
				runId: approval.runId,
				detail: { approvalId: approval.id, reason, toolName: approval.toolName },
			});
		}
	}

	#scheduleApprovalExpiry(approval: StudioApproval): void {
		this.#clearApprovalExpiry(approval.id);
		if (approval.status !== "pending") return;
		const delayMs = approval.expiresAtMs - Date.now();
		const timer = setTimeout(
			() => {
				this.#approvalExpiryTimers.delete(approval.id);
				void this.#expireApproval(approval.id);
			},
			Math.max(0, delayMs),
		);
		timer.unref();
		this.#approvalExpiryTimers.set(approval.id, timer);
	}

	async #expireApproval(approvalId: string): Promise<void> {
		const approval = this.#store.getStudioApproval(approvalId);
		if (!approval || !["pending", "expired"].includes(approval.status)) return;
		if (approval.status === "expired" && !this.#pendingApprovals.has(approvalId)) return;
		if (approval.status === "pending" && approval.expiresAtMs > Date.now()) {
			this.#scheduleApprovalExpiry(approval);
			return;
		}
		try {
			await this.resolveApproval(approvalId, false);
		} catch (error) {
			if (!(error instanceof StudioRpcSupervisorError) || error.code !== "approval_expired") {
				logger.debug("Studio could not expire an OMP tool approval", {
					approvalId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#clearApprovalExpiry(approvalId: string): void {
		const timer = this.#approvalExpiryTimers.get(approvalId);
		if (timer) clearTimeout(timer);
		this.#approvalExpiryTimers.delete(approvalId);
	}

	#clearApprovalExpiryTimers(): void {
		for (const timer of this.#approvalExpiryTimers.values()) clearTimeout(timer);
		this.#approvalExpiryTimers.clear();
	}

	#handleSubagentState(studioSessionId: string, subagent: StudioSubagent): void {
		if (this.#closed) return;
		let subagents = this.#subagentsBySession.get(studioSessionId);
		if (!subagents) {
			subagents = new Map();
			this.#subagentsBySession.set(studioSessionId, subagents);
		}
		subagents.set(subagent.id, subagent);
		this.#events.onSubagentState(studioSessionId, subagent);
	}

	#handlePlanSummary(studioSessionId: string, active: ActiveStudioRpcSession, summary: StudioRpcPlanSummary): void {
		if (this.#closed || this.#activeSessions.get(studioSessionId) !== active) return;
		const run = this.#store.getStudioSession(studioSessionId)?.activeRun;
		if (!run) return;
		try {
			const plan = this.#store.upsertStudioPlanSummary({
				studioSessionId,
				runId: run.id,
				...summary,
			});
			if (plan) this.#events.onPlanSummaryUpdated(studioSessionId, plan);
		} catch {
			logger.warn("Studio rejected an OMP plan summary", { studioSessionId });
		}
	}

	#emitToolDisplayTerminalUpdates(
		runId: string,
		status: Extract<StudioToolDisplayStatus, "completed" | "failed" | "cancelled">,
	): void {
		for (const display of this.#store.finishStudioRunToolDisplays(runId, status)) {
			this.#events.onToolDisplayUpdated(display.studioSessionId, display);
		}
		this.#toolDisplayIdsByRun.delete(runId);
	}

	async #refreshUsage(studioSessionId: string, transport: StudioRpcTransport): Promise<void> {
		if (!transport.getUsage || this.#usageRefreshInFlight.has(studioSessionId)) return;
		this.#usageRefreshInFlight.add(studioSessionId);
		try {
			const usage = await transport.getUsage();
			const session = this.#store.updateStudioSessionUsage(studioSessionId, usage);
			if (session?.activeRun) {
				this.#store.appendStudioUsageHistory({
					runId: session.activeRun.id,
					studioSessionId,
					usage,
				});
			}
			if (session?.usage) this.#events.onUsageUpdated(session, session.usage);
		} catch (error) {
			logger.debug("Studio could not refresh OMP session usage", {
				studioSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.#usageRefreshInFlight.delete(studioSessionId);
		}
	}

	#finishTranscriptMessages(runId: string, status: "completed" | "failed" | "interrupted"): void {
		this.#flushPendingTranscriptUpdatesForRun(runId);
		for (const message of this.#store.finishStudioTranscriptMessages(runId, status)) {
			this.#events.onTranscriptUpdated(message.studioSessionId, message);
		}
		this.#transcriptSourceIdsByRun.delete(runId);
	}

	#finishTranscriptForTerminalRun(runId: string): void {
		const run = this.#store.getStudioRun(runId);
		if (!run) return;
		if (run.status === "completed" || run.status === "failed") {
			this.#finishTranscriptMessages(run.id, run.status);
		} else if (run.status === "cancelled" || run.status === "interrupted") {
			this.#finishTranscriptMessages(run.id, "interrupted");
		}
	}

	#persistedTranscriptSourceId(runId: string, transportSourceId: string): string {
		let sourceIds = this.#transcriptSourceIdsByRun.get(runId);
		if (!sourceIds) {
			sourceIds = new Map();
			this.#transcriptSourceIdsByRun.set(runId, sourceIds);
		}
		const existing = sourceIds.get(transportSourceId);
		if (existing) return existing;
		const sourceId = sourceIds.size === 0 ? INITIAL_ASSISTANT_TRANSCRIPT_SOURCE_ID : transportSourceId;
		sourceIds.set(transportSourceId, sourceId);
		return sourceId;
	}

	#queueTranscriptUpdate(studioSessionId: string, runId: string, update: StudioRpcTranscriptUpdate): void {
		const sourceId = this.#persistedTranscriptSourceId(runId, update.sourceId);
		const key = `${runId}\u0000${sourceId}`;
		const normalizedUpdate = { ...update, sourceId };
		if (normalizedUpdate.status !== "streaming") {
			this.#clearPendingTranscriptUpdate(key);
			this.#persistTranscriptUpdate(studioSessionId, runId, normalizedUpdate);
			return;
		}

		this.#pendingTranscriptUpdates.set(key, { runId, studioSessionId, update: normalizedUpdate });
		if (this.#transcriptUpdateTimers.has(key)) return;
		const timer = setTimeout(() => {
			this.#transcriptUpdateTimers.delete(key);
			this.#flushPendingTranscriptUpdate(key);
		}, STUDIO_TRANSCRIPT_UPDATE_INTERVAL_MS);
		timer.unref();
		this.#transcriptUpdateTimers.set(key, timer);
	}

	#clearPendingTranscriptUpdate(key: string): void {
		const timer = this.#transcriptUpdateTimers.get(key);
		if (timer) clearTimeout(timer);
		this.#transcriptUpdateTimers.delete(key);
		this.#pendingTranscriptUpdates.delete(key);
	}

	#flushPendingTranscriptUpdate(key: string): void {
		const pending = this.#pendingTranscriptUpdates.get(key);
		this.#clearPendingTranscriptUpdate(key);
		if (pending) this.#persistTranscriptUpdate(pending.studioSessionId, pending.runId, pending.update);
	}

	#flushPendingTranscriptUpdatesForRun(runId: string): void {
		for (const [key, pending] of this.#pendingTranscriptUpdates) {
			if (pending.runId === runId) this.#flushPendingTranscriptUpdate(key);
		}
	}

	#flushPendingTranscriptUpdates(): void {
		for (const key of this.#pendingTranscriptUpdates.keys()) this.#flushPendingTranscriptUpdate(key);
	}

	#handlePromptFailure(studioSessionId: string, active: ActiveStudioRpcSession): void {
		if (this.#closed || this.#activeSessions.get(studioSessionId) !== active) return;
		if (active.awaitingPromptAcceptance) {
			active.awaitingPromptAcceptance.promptFailure = true;
			return;
		}
		const session = this.#store.getStudioSession(studioSessionId);
		const run = session?.activeRun;
		if (!run || run.status === "cancelling") return;

		this.#interruptRunApprovals(run.id, "rpc_prompt_failed");
		const failed = this.#store.finishStudioRun(run.id, "failed", "rpc_prompt_failed");
		if (!failed) return;
		this.#emitToolDisplayTerminalUpdates(run.id, "failed");
		this.#finishTranscriptMessages(run.id, "failed");
		const readySession = this.#store.updateStudioSessionRuntime(studioSessionId, { status: "ready" });
		if (readySession) this.#events.onRunState(readySession, failed);
		this.#store.appendAuditEntry({
			action: "run_failed",
			studioSessionId,
			runId: run.id,
			detail: { reason: "rpc_prompt_failed" },
		});
	}

	#handlePromptResult(studioSessionId: string, active: ActiveStudioRpcSession, result: StudioRpcPromptResult): void {
		if (this.#closed || this.#activeSessions.get(studioSessionId) !== active || result.agentInvoked) return;
		if (active.awaitingPromptAcceptance) {
			active.awaitingPromptAcceptance.promptResult = result;
			return;
		}
		const session = this.#store.getStudioSession(studioSessionId);
		const run = session?.activeRun;
		if (!run || run.status === "cancelling") return;

		this.#interruptRunApprovals(run.id, "run_completed");
		const completed = this.#store.finishStudioRun(run.id, "completed");
		if (!completed) return;
		this.#emitToolDisplayTerminalUpdates(run.id, "completed");
		this.#finishTranscriptMessages(run.id, "completed");
		const readySession = this.#store.updateStudioSessionRuntime(studioSessionId, { status: "ready" });
		if (readySession) this.#events.onRunState(readySession, completed);
		this.#store.appendAuditEntry({
			action: "run_completed",
			studioSessionId,
			runId: run.id,
			detail: {},
		});
	}

	#handleTranscriptUpdate(
		studioSessionId: string,
		active: ActiveStudioRpcSession,
		update: StudioRpcTranscriptUpdate,
	): void {
		if (this.#closed || this.#activeSessions.get(studioSessionId) !== active) return;
		if (active.awaitingPromptAcceptance) {
			active.awaitingPromptAcceptance.transcriptUpdates.push(update);
			return;
		}
		const run = this.#store.getStudioSession(studioSessionId)?.activeRun;
		if (!run) return;
		this.#queueTranscriptUpdate(studioSessionId, run.id, update);
	}

	#persistTranscriptUpdate(studioSessionId: string, runId: string, update: StudioRpcTranscriptUpdate): void {
		try {
			const message = this.#store.upsertStudioAssistantTranscriptMessage({
				studioSessionId,
				runId,
				sourceId: this.#persistedTranscriptSourceId(runId, update.sourceId),
				status: update.status,
				text: update.text,
			});
			if (message) this.#events.onTranscriptUpdated(studioSessionId, message);
		} catch {
			logger.warn("Studio rejected an OMP transcript update", { studioSessionId });
		}
	}

	#handleToolDisplayEvent(studioSessionId: string, run: StudioRun, event: StudioRpcAgentEvent): void {
		if (event.type === "tool_execution_start" && event.toolCallId) {
			try {
				const display = this.#store.appendStudioToolDisplay({
					studioSessionId,
					runId: run.id,
					kind: projectStudioToolDisplayKind(event.toolName),
				});
				if (!display) return;
				let displays = this.#toolDisplayIdsByRun.get(run.id);
				if (!displays) {
					displays = new Map();
					this.#toolDisplayIdsByRun.set(run.id, displays);
				}
				displays.set(event.toolCallId, display.id);
				this.#events.onToolDisplayUpdated(studioSessionId, display);
			} catch {
				logger.warn("Studio rejected an OMP tool card", { studioSessionId });
			}
			return;
		}
		if (event.type !== "tool_execution_end" || !event.toolCallId) return;
		const displays = this.#toolDisplayIdsByRun.get(run.id);
		const displayId = displays?.get(event.toolCallId);
		if (!displayId) return;
		const status: StudioToolDisplayStatus =
			run.status === "cancelling" ? "cancelled" : event.isError ? "failed" : "completed";
		try {
			const display = this.#store.updateStudioToolDisplay(displayId, status);
			if (!display) return;
			displays?.delete(event.toolCallId);
			this.#events.onToolDisplayUpdated(studioSessionId, display);
		} catch {
			logger.warn("Studio could not settle an OMP tool card", { studioSessionId });
		}
	}

	#handleAgentEvent(studioSessionId: string, event: StudioRpcAgentEvent): void {
		if (this.#closed) return;
		const session = this.#store.getStudioSession(studioSessionId);
		const run = session?.activeRun;
		if (!session || !run) return;
		this.#handleToolDisplayEvent(studioSessionId, run, event);

		const projection = projectStudioActivityEvent(event, { runCancelling: run.status === "cancelling" });
		if (projection) {
			try {
				const entry = this.#store.appendStudioActivityEntry({
					runId: run.id,
					status: projection.status,
					studioSessionId,
					subject: projection.subject,
				});
				if (entry) this.#events.onActivityUpdated(studioSessionId, entry);
			} catch {
				logger.warn("Studio rejected an OMP activity event", { studioSessionId });
			}
		}

		if (event.type !== "message_update") {
			this.#events.onAgentEvent(studioSessionId, run.id, toStudioAgentEvent(event));
		}
		const active = this.#activeSessions.get(studioSessionId);
		if (event.type === "message_end" && active) void this.#refreshUsage(studioSessionId, active.transport);
		if (isAgentStart(event) && run.status === "starting") {
			this.#markRunRunning({ kind: "created", run });
			return;
		}
		if (!isTerminalAgentEnd(event)) return;

		const status = run.status === "cancelling" ? "cancelled" : event.isError ? "failed" : "completed";
		const reason =
			status === "cancelled" ? "run_cancelled" : status === "failed" ? "rpc_agent_failed" : "run_completed";
		this.#interruptRunApprovals(run.id, reason);
		const completed = this.#store.finishStudioRun(run.id, status);
		this.#emitToolDisplayTerminalUpdates(run.id, status);
		this.#finishTranscriptMessages(
			run.id,
			status === "cancelled" ? "interrupted" : status === "failed" ? "failed" : "completed",
		);
		const readySession = this.#store.updateStudioSessionRuntime(studioSessionId, { status: "ready" });
		if (completed && readySession) this.#events.onRunState(readySession, completed);
		if (active) void this.#refreshUsage(studioSessionId, active.transport);
		this.#store.appendAuditEntry({
			action: status === "cancelled" ? "run_cancelled" : status === "failed" ? "run_failed" : "run_completed",
			studioSessionId,
			runId: run.id,
			detail: status === "failed" ? { reason } : {},
		});
	}

	#handleTransportExit(studioSessionId: string, active: ActiveStudioRpcSession, exit: StudioRpcTransportExit): void {
		if (this.#activeSessions.get(studioSessionId) !== active) return;
		active.onApprovalRequest();
		active.onEvent();
		active.onExit();
		active.onPromptFailure();
		active.onPromptResult();
		active.onSubagentState();
		active.onPlanSummary();
		active.onTranscriptUpdate();
		this.#activeSessions.delete(studioSessionId);
		this.#subagentsBySession.delete(studioSessionId);
		if (this.#closed || exit.expected) return;

		const session = this.#store.getStudioSession(studioSessionId);
		const activeRun = session?.activeRun;
		const interrupted = activeRun
			? this.#store.finishStudioRun(activeRun.id, "interrupted", "rpc_child_exited")
			: undefined;
		if (activeRun) this.#emitToolDisplayTerminalUpdates(activeRun.id, "cancelled");
		if (activeRun) this.#interruptRunApprovals(activeRun.id, "rpc_child_exited");
		if (activeRun) this.#finishTranscriptMessages(activeRun.id, "interrupted");
		const interruptedSession = this.#store.updateStudioSessionRuntime(studioSessionId, { status: "interrupted" });
		if (interrupted && interruptedSession) this.#events.onRunState(interruptedSession, interrupted);
		this.#store.appendAuditEntry({
			action: "session_interrupted",
			studioSessionId,
			...(activeRun ? { runId: activeRun.id } : {}),
			detail: { reason: "rpc_child_exited" },
		});
	}
}
