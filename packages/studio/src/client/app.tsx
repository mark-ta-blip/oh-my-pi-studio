import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	StudioApproval,
	StudioApprovalListResponse,
	StudioApprovalResponse,
	StudioAuditEntry,
	StudioAuditListResponse,
	StudioAuthContinueResponse,
	StudioAuthProgress,
	StudioBootstrap,
	StudioControlLeaseResponse,
	StudioEventEnvelope,
	StudioEventResyncRequired,
	StudioPromptResponse,
	StudioProvider,
	StudioProviderListResponse,
	StudioProviderLoginResponse,
	StudioRun,
	StudioRunResponse,
	StudioSession,
	StudioSessionListResponse,
	StudioSessionResponse,
	StudioSubagent,
	StudioSubagentListResponse,
	StudioUsage,
	StudioWorkspace,
	StudioWorkspaceListResponse,
	StudioWorkspaceResponse,
} from "../protocol";

type ConnectionState = "connecting" | "ready" | "offline";

interface StudioAgentEventItem {
	emittedAtMs: number;
	runId: string;
	sequence: number;
	studioSessionId: string;
	summary: string;
	toolName?: string;
	type: string;
}

type StudioAgentEventData = Record<string, unknown> & { type: string };

function parseStudioReady(message: unknown): message is StudioEventEnvelope<StudioBootstrap> {
	if (!message || typeof message !== "object") return false;
	const event = message as Record<string, unknown>;
	return event.type === "studio.ready" && typeof event.data === "object" && event.data !== null;
}

function parseAuthProgress(message: unknown): message is StudioEventEnvelope<StudioAuthProgress> {
	if (!message || typeof message !== "object") return false;
	const event = message as Record<string, unknown>;
	if (event.type !== "auth.progress" || !isRecord(event.data)) return false;
	const data = event.data;
	return (
		typeof data.flowId === "string" &&
		typeof data.providerId === "string" &&
		typeof data.phase === "string" &&
		["authorization", "progress", "prompt", "completed", "failed", "cancelled"].includes(data.phase)
	);
}

function parseRunState(message: unknown): message is StudioEventEnvelope<StudioRun> & {
	runId: string;
	studioSessionId: string;
} {
	if (!message || typeof message !== "object") return false;
	const event = message as Record<string, unknown>;
	if (event.type !== "run.state" || !isRecord(event.data)) return false;
	const data = event.data;
	return (
		typeof event.runId === "string" &&
		typeof event.studioSessionId === "string" &&
		typeof data.id === "string" &&
		typeof data.status === "string" &&
		typeof data.studioSessionId === "string"
	);
}

function parseAgentEvent(message: unknown): message is StudioEventEnvelope<StudioAgentEventData> & {
	runId: string;
	studioSessionId: string;
} {
	if (!message || typeof message !== "object") return false;
	const event = message as Record<string, unknown>;
	return (
		event.type === "agent.event" &&
		typeof event.runId === "string" &&
		typeof event.studioSessionId === "string" &&
		isRecord(event.data) &&
		typeof event.data.type === "string"
	);
}

function isStudioApproval(value: unknown): value is StudioApproval {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.runId === "string" &&
		typeof value.studioSessionId === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		typeof value.argumentsDigest === "string" &&
		typeof value.requestedAtMs === "number" &&
		typeof value.expiresAtMs === "number" &&
		typeof value.status === "string" &&
		["pending", "approved", "rejected", "expired", "interrupted"].includes(value.status)
	);
}

function parseApprovalEvent(
	message: unknown,
): message is StudioEventEnvelope<StudioApproval> & { studioSessionId: string } {
	if (!isRecord(message)) return false;
	return (
		(message.type === "approval.requested" || message.type === "approval.resolved") &&
		typeof message.studioSessionId === "string" &&
		isStudioApproval(message.data)
	);
}

function isStudioSubagent(value: unknown): value is StudioSubagent {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.index === "number" &&
		typeof value.agent === "string" &&
		typeof value.agentSource === "string" &&
		typeof value.updatedAtMs === "number" &&
		typeof value.status === "string" &&
		["pending", "running", "completed", "failed", "aborted"].includes(value.status)
	);
}

function parseSubagentState(
	message: unknown,
): message is StudioEventEnvelope<StudioSubagent> & { studioSessionId: string } {
	if (!isRecord(message)) return false;
	return (
		message.type === "subagent.state" && typeof message.studioSessionId === "string" && isStudioSubagent(message.data)
	);
}

function isStudioUsage(value: unknown): value is StudioUsage {
	if (!isRecord(value)) return false;
	const required = [
		"inputTokens",
		"outputTokens",
		"reasoningTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"totalTokens",
		"premiumRequests",
		"cost",
		"toolCalls",
		"updatedAtMs",
	];
	return required.every(key => typeof value[key] === "number" && Number.isFinite(value[key]));
}

function parseUsageUpdated(
	message: unknown,
): message is StudioEventEnvelope<StudioUsage> & { studioSessionId: string } {
	if (!isRecord(message)) return false;
	return (
		message.type === "usage.updated" && typeof message.studioSessionId === "string" && isStudioUsage(message.data)
	);
}

function websocketUrl(afterSequence: number): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/v1/events`);
	if (afterSequence > 0) url.searchParams.set("after", String(afterSequence));
	return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventSequence(value: unknown): number | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.sequence !== "number") return undefined;
	return Number.isSafeInteger(value.sequence) && value.sequence >= 0 ? value.sequence : undefined;
}

function parseResyncRequired(message: unknown): message is StudioEventEnvelope<StudioEventResyncRequired> {
	if (!isRecord(message) || message.type !== "studio.resync_required" || !isRecord(message.data)) return false;
	return (
		typeof message.data.afterSequence === "number" &&
		typeof message.data.latestSequence === "number" &&
		Number.isSafeInteger(message.data.afterSequence) &&
		Number.isSafeInteger(message.data.latestSequence)
	);
}

async function responseError(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
	} catch {
		// Use the stable HTTP fallback when a local response does not contain an API error body.
	}
	return `Studio request failed with HTTP ${response.status}.`;
}

function sortWorkspaces(workspaces: StudioWorkspace[]): StudioWorkspace[] {
	return [...workspaces].sort(
		(left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
	);
}

function sortProviders(providers: StudioProvider[]): StudioProvider[] {
	return [...providers].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function sortSessions(sessions: StudioSession[]): StudioSession[] {
	return [...sessions].sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.id.localeCompare(right.id));
}

function upsertApproval(approvals: StudioApproval[], approval: StudioApproval): StudioApproval[] {
	return [...approvals.filter(current => current.id !== approval.id), approval].sort(
		(left, right) => right.requestedAtMs - left.requestedAtMs || left.id.localeCompare(right.id),
	);
}

function upsertSubagent(subagents: StudioSubagent[], subagent: StudioSubagent): StudioSubagent[] {
	return [...subagents.filter(current => current.id !== subagent.id), subagent].sort(
		(left, right) => left.index - right.index || left.id.localeCompare(right.id),
	);
}

function createHolderId(): string {
	const storageKey = "omp-studio-holder-id";
	try {
		const existing = sessionStorage.getItem(storageKey);
		if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
		const created = `tab_${crypto.randomUUID().replaceAll("-", "")}`;
		sessionStorage.setItem(storageKey, created);
		return created;
	} catch {
		return `tab_${crypto.randomUUID().replaceAll("-", "")}`;
	}
}

function isTerminalRunStatus(status: StudioRun["status"]): boolean {
	return ["completed", "cancelled", "interrupted", "failed"].includes(status);
}

function summarizeAgentEvent(event: Record<string, unknown>): string {
	const type = typeof event.type === "string" ? event.type : "agent event";
	const toolName = typeof event.toolName === "string" ? event.toolName : "a tool";
	if (type === "message_update") return "Assistant response is streaming.";
	if (type === "tool_execution_start") return `OMP started ${toolName}.`;
	if (type === "tool_execution_end") return `OMP finished ${toolName}.`;
	if (type === "agent_end" && event.isTerminal === false) return "OMP will continue this run.";
	if (type === "agent_end") return "OMP reached the end of this run.";
	return type.replaceAll("_", " ");
}

function providerState(provider: StudioProvider): string {
	if (provider.authState === "authenticated") return provider.credentialOrigin?.replaceAll("_", " ") ?? "connected";
	return provider.authState === "keyless" ? "local engine" : "not connected";
}

function promptNeedsSecretInput(progress: StudioAuthProgress): boolean {
	const message = progress.prompt?.message ?? "";
	return /api[ _-]?key|token|secret|password/i.test(message);
}

function formatWorkspaceDate(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(timestamp);
}

function formatCount(value: number): string {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatCost(value: number): string {
	return new Intl.NumberFormat(undefined, {
		maximumFractionDigits: 4,
		minimumFractionDigits: value > 0 ? 2 : 0,
	}).format(value);
}

function formatAuditAction(action: string): string {
	return action.replaceAll("_", " ");
}

function formatAuditDetail(entry: StudioAuditEntry): string | null {
	const values = Object.entries(entry.detail);
	if (values.length === 0) return null;
	return values.map(([key, value]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${value}`).join(" / ");
}

export function App(): ReactNode {
	const [bootstrap, setBootstrap] = useState<StudioBootstrap | null>(null);
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	const [error, setError] = useState<string | null>(null);
	const [workspaces, setWorkspaces] = useState<StudioWorkspace[]>([]);
	const [workspaceError, setWorkspaceError] = useState<string | null>(null);
	const [workspaceLabel, setWorkspaceLabel] = useState("");
	const [workspacePath, setWorkspacePath] = useState("");
	const [workspacePending, setWorkspacePending] = useState(false);
	const [providers, setProviders] = useState<StudioProvider[]>([]);
	const [providerError, setProviderError] = useState<string | null>(null);
	const [providerPending, setProviderPending] = useState<string | null>(null);
	const [authFlow, setAuthFlow] = useState<StudioAuthProgress | null>(null);
	const [authResponse, setAuthResponse] = useState("");
	const [authPending, setAuthPending] = useState(false);
	const [holderId] = useState(createHolderId);
	const [sessions, setSessions] = useState<StudioSession[]>([]);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [sessionName, setSessionName] = useState("");
	const [sessionWorkspaceId, setSessionWorkspaceId] = useState("");
	const [sessionProviderId, setSessionProviderId] = useState("");
	const [sessionModelId, setSessionModelId] = useState("");
	const [sessionPending, setSessionPending] = useState(false);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
	const [promptText, setPromptText] = useState("");
	const [promptPending, setPromptPending] = useState(false);
	const [controlPendingId, setControlPendingId] = useState<string | null>(null);
	const [leaseExpiresAtMs, setLeaseExpiresAtMs] = useState<Record<string, number>>({});
	const [agentEvents, setAgentEvents] = useState<StudioAgentEventItem[]>([]);
	const [approvalPendingId, setApprovalPendingId] = useState<string | null>(null);
	const [approvalsBySession, setApprovalsBySession] = useState<Record<string, StudioApproval[]>>({});
	const [subagentsBySession, setSubagentsBySession] = useState<Record<string, StudioSubagent[]>>({});
	const [auditEntries, setAuditEntries] = useState<StudioAuditEntry[]>([]);
	const [auditNextBeforeId, setAuditNextBeforeId] = useState<number | null>(null);
	const [auditPending, setAuditPending] = useState(false);
	const [auditError, setAuditError] = useState<string | null>(null);
	const [resyncRevision, setResyncRevision] = useState(0);
	const lastEventSequenceRef = useRef(0);

	const loadProviders = useCallback(async (): Promise<void> => {
		setProviderError(null);
		try {
			const response = await fetch("/api/v1/providers");
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioProviderListResponse;
			setProviders(sortProviders(body.providers));
		} catch (reason) {
			setProviderError(reason instanceof Error ? reason.message : "Studio could not load OMP providers.");
		}
	}, []);

	const loadSessions = useCallback(async (): Promise<void> => {
		setSessionError(null);
		try {
			const response = await fetch("/api/v1/sessions");
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioSessionListResponse;
			setSessions(sortSessions(body.sessions));
		} catch (reason) {
			setSessionError(reason instanceof Error ? reason.message : "Studio could not load local sessions.");
		}
	}, []);

	const requestAuditEntries = useCallback(
		async (studioSessionId: string, beforeId?: number): Promise<StudioAuditListResponse> => {
			const query = new URLSearchParams({ limit: "40", sessionId: studioSessionId });
			if (beforeId !== undefined) query.set("before", String(beforeId));
			const response = await fetch(`/api/v1/audit?${query.toString()}`);
			if (!response.ok) throw new Error(await responseError(response));
			return (await response.json()) as StudioAuditListResponse;
		},
		[],
	);

	useEffect(() => {
		let active = true;
		fetch("/api/v1/bootstrap")
			.then(async response => {
				if (!response.ok) throw new Error(`Bootstrap request failed with HTTP ${response.status}`);
				return (await response.json()) as StudioBootstrap;
			})
			.then(data => {
				if (active) setBootstrap(data);
			})
			.catch(reason => {
				if (active) setError(reason instanceof Error ? reason.message : "Studio bootstrap failed.");
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		let active = true;
		fetch("/api/v1/workspaces")
			.then(async response => {
				if (!response.ok) throw new Error(await responseError(response));
				return (await response.json()) as StudioWorkspaceListResponse;
			})
			.then(data => {
				if (active) setWorkspaces(sortWorkspaces(data.workspaces));
			})
			.catch(reason => {
				if (active)
					setWorkspaceError(reason instanceof Error ? reason.message : "Studio could not load workspaces.");
			});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (!bootstrap?.features.providerOnboarding) return;
		void loadProviders();
	}, [bootstrap?.features.providerOnboarding, loadProviders]);

	useEffect(() => {
		if (!bootstrap?.features.rpcSupervisor) return;
		void loadSessions();
	}, [bootstrap?.features.rpcSupervisor, loadSessions, resyncRevision]);

	useEffect(() => {
		if (workspaces.some(workspace => workspace.id === sessionWorkspaceId)) return;
		setSessionWorkspaceId(workspaces[0]?.id ?? "");
	}, [sessionWorkspaceId, workspaces]);

	useEffect(() => {
		const provider =
			providers.find(candidate => candidate.id === sessionProviderId && candidate.models.length > 0) ??
			providers.find(candidate => candidate.models.length > 0);
		if (!provider) {
			setSessionProviderId("");
			setSessionModelId("");
			return;
		}
		if (provider.id !== sessionProviderId) setSessionProviderId(provider.id);
		const model = provider.models.find(candidate => candidate.id === sessionModelId) ?? provider.models[0];
		if (model && model.id !== sessionModelId) setSessionModelId(model.id);
	}, [providers, sessionModelId, sessionProviderId]);

	useEffect(() => {
		if (selectedSessionId && sessions.some(session => session.id === selectedSessionId)) return;
		setSelectedSessionId(sessions[0]?.id ?? null);
	}, [selectedSessionId, sessions]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.approvalControls) return;
		let active = true;
		fetch(`/api/v1/sessions/${encodeURIComponent(selectedSessionId)}/approvals`)
			.then(async response => {
				if (!response.ok) throw new Error(await responseError(response));
				return (await response.json()) as StudioApprovalListResponse;
			})
			.then(body => {
				if (active) setApprovalsBySession(current => ({ ...current, [selectedSessionId]: body.approvals }));
			})
			.catch(reason => {
				if (active)
					setSessionError(reason instanceof Error ? reason.message : "Studio could not load tool approvals.");
			});
		return () => {
			active = false;
		};
	}, [bootstrap?.features.approvalControls, resyncRevision, selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.subagentVisibility) return;
		let active = true;
		fetch(`/api/v1/sessions/${encodeURIComponent(selectedSessionId)}/subagents`)
			.then(async response => {
				if (!response.ok) throw new Error(await responseError(response));
				return (await response.json()) as StudioSubagentListResponse;
			})
			.then(body => {
				if (active) setSubagentsBySession(current => ({ ...current, [selectedSessionId]: body.subagents }));
			})
			.catch(reason => {
				if (active)
					setSessionError(reason instanceof Error ? reason.message : "Studio could not load subagent status.");
			});
		return () => {
			active = false;
		};
	}, [bootstrap?.features.subagentVisibility, resyncRevision, selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.auditReview) {
			setAuditEntries([]);
			setAuditNextBeforeId(null);
			setAuditError(null);
			return;
		}
		let active = true;
		setAuditPending(true);
		setAuditError(null);
		void requestAuditEntries(selectedSessionId)
			.then(body => {
				if (!active) return;
				setAuditEntries(body.entries);
				setAuditNextBeforeId(body.nextBeforeId ?? null);
			})
			.catch(reason => {
				if (active)
					setAuditError(reason instanceof Error ? reason.message : "Studio could not load the audit ledger.");
			})
			.finally(() => {
				if (active) setAuditPending(false);
			});
		return () => {
			active = false;
		};
	}, [bootstrap?.features.auditReview, requestAuditEntries, resyncRevision, selectedSessionId]);

	useEffect(() => {
		let disposed = false;
		let reconnectAttempt = 0;
		let reconnectTimer: number | undefined;
		let activeSocket: WebSocket | undefined;

		function scheduleReconnect(): void {
			if (disposed || reconnectTimer !== undefined) return;
			setConnection("offline");
			const delayMs = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
			reconnectAttempt += 1;
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = undefined;
				connect();
			}, delayMs);
		}

		function connect(): void {
			if (disposed) return;
			const socket = new WebSocket(websocketUrl(lastEventSequenceRef.current));
			activeSocket = socket;
			socket.addEventListener("open", () => {
				if (activeSocket === socket) setConnection("connecting");
			});
			socket.addEventListener("message", event => {
				if (activeSocket !== socket) return;
				try {
					const message: unknown = JSON.parse(String(event.data));
					const sequence = eventSequence(message);
					if (sequence === undefined) throw new Error("Studio event sequence is invalid.");
					if (parseStudioReady(message)) {
						setConnection("ready");
						reconnectAttempt = 0;
						return;
					}
					if (parseResyncRequired(message)) {
						lastEventSequenceRef.current = Math.max(
							lastEventSequenceRef.current,
							sequence,
							message.data.latestSequence,
						);
						setAgentEvents([]);
						setApprovalsBySession({});
						setSubagentsBySession({});
						setResyncRevision(current => current + 1);
						return;
					}
					if (sequence <= lastEventSequenceRef.current) return;
					lastEventSequenceRef.current = sequence;
					if (parseAuthProgress(message)) {
						const progress = message.data;
						setAuthFlow(progress);
						if (progress.phase === "completed" || progress.phase === "failed" || progress.phase === "cancelled") {
							setProviderPending(null);
							setAuthPending(false);
							setAuthResponse("");
							if (progress.phase === "completed") {
								void loadProviders();
							} else if (progress.message) {
								setProviderError(progress.message);
							}
						}
						return;
					}
					if (parseRunState(message)) {
						const run = message.data;
						setSessions(current =>
							sortSessions(
								current.map(session => {
									if (session.id !== message.studioSessionId) return session;
									if (isTerminalRunStatus(run.status)) {
										return {
											...session,
											activeRun: undefined,
											status: run.status === "failed" ? "failed" : "ready",
										};
									}
									return { ...session, activeRun: run, status: "running" };
								}),
							),
						);
						return;
					}
					if (parseApprovalEvent(message)) {
						setApprovalsBySession(current => ({
							...current,
							[message.studioSessionId]: upsertApproval(current[message.studioSessionId] ?? [], message.data),
						}));
						return;
					}
					if (parseSubagentState(message)) {
						setSubagentsBySession(current => ({
							...current,
							[message.studioSessionId]: upsertSubagent(current[message.studioSessionId] ?? [], message.data),
						}));
						return;
					}
					if (parseUsageUpdated(message)) {
						setSessions(current =>
							sortSessions(
								current.map(session =>
									session.id === message.studioSessionId
										? { ...session, updatedAtMs: message.data.updatedAtMs, usage: message.data }
										: session,
								),
							),
						);
						return;
					}
					if (parseAgentEvent(message)) {
						const payload = message.data;
						setAgentEvents(current =>
							[
								{
									emittedAtMs: message.emittedAtMs,
									runId: message.runId,
									sequence,
									studioSessionId: message.studioSessionId,
									summary: summarizeAgentEvent(payload),
									...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
									type: payload.type,
								},
								...current,
							].slice(0, 40),
						);
					}
				} catch {
					setConnection("offline");
					if (socket.readyState === WebSocket.OPEN) socket.close(1002, "invalid Studio event");
				}
			});
			socket.addEventListener("error", () => {
				if (activeSocket === socket) scheduleReconnect();
			});
			socket.addEventListener("close", () => {
				if (activeSocket !== socket) return;
				activeSocket = undefined;
				scheduleReconnect();
			});
		}

		connect();
		return () => {
			disposed = true;
			if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
			activeSocket?.close();
		};
	}, [loadProviders]);

	const profile = bootstrap?.profile ?? "loading";
	const profileReady = bootstrap !== null && error === null;
	const providerOnboarding = bootstrap?.features.providerOnboarding === true;
	const rpcSupervisor = bootstrap?.features.rpcSupervisor === true;
	const approvalControls = bootstrap?.features.approvalControls === true;
	const subagentVisibility = bootstrap?.features.subagentVisibility === true;
	const usageSummary = bootstrap?.features.usageSummary === true;
	const auditReview = bootstrap?.features.auditReview === true;
	const selectedSession = useMemo(
		() => sessions.find(session => session.id === selectedSessionId) ?? null,
		[sessions, selectedSessionId],
	);
	const selectedProvider = useMemo(
		() => providers.find(provider => provider.id === sessionProviderId) ?? null,
		[providers, sessionProviderId],
	);
	const selectedProviderModels = selectedProvider?.models ?? [];
	const selectedSessionEvents = useMemo(
		() => agentEvents.filter(event => event.studioSessionId === selectedSessionId),
		[agentEvents, selectedSessionId],
	);
	const selectedApprovals = selectedSessionId ? (approvalsBySession[selectedSessionId] ?? []) : [];
	const selectedSubagents = selectedSessionId ? (subagentsBySession[selectedSessionId] ?? []) : [];

	const registerWorkspace = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		const path = workspacePath.trim();
		if (!path || workspacePending) return;
		setWorkspaceError(null);
		setWorkspacePending(true);
		try {
			const label = workspaceLabel.trim();
			const response = await fetch("/api/v1/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...(label ? { label } : {}), path }),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioWorkspaceResponse;
			setWorkspaces(current =>
				sortWorkspaces([...current.filter(workspace => workspace.id !== body.workspace.id), body.workspace]),
			);
			setWorkspaceLabel("");
			setWorkspacePath("");
		} catch (reason) {
			setWorkspaceError(reason instanceof Error ? reason.message : "Studio could not register the workspace.");
		} finally {
			setWorkspacePending(false);
		}
	};

	const removeWorkspace = async (workspaceId: string): Promise<void> => {
		if (workspacePending) return;
		setWorkspaceError(null);
		setWorkspacePending(true);
		try {
			const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
			if (!response.ok) throw new Error(await responseError(response));
			setWorkspaces(current => current.filter(workspace => workspace.id !== workspaceId));
		} catch (reason) {
			setWorkspaceError(reason instanceof Error ? reason.message : "Studio could not remove the workspace.");
		} finally {
			setWorkspacePending(false);
		}
	};

	const startProviderLogin = async (provider: StudioProvider): Promise<void> => {
		if (!provider.canLogin || providerPending !== null) return;
		setProviderError(null);
		setProviderPending(provider.id);
		try {
			const response = await fetch(`/api/v1/providers/${encodeURIComponent(provider.id)}/login`, { method: "POST" });
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioProviderLoginResponse;
			setAuthResponse("");
			setAuthFlow({
				flowId: body.flowId,
				providerId: body.providerId,
				phase: "progress",
				message: "Preparing provider sign-in...",
			});
		} catch (reason) {
			setProviderPending(null);
			setProviderError(reason instanceof Error ? reason.message : "Studio could not start provider sign-in.");
		}
	};

	const submitAuthResponse = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (authFlow?.phase !== "prompt" || authPending) return;
		if (!authFlow.prompt?.allowEmpty && authResponse.length === 0) return;
		setProviderError(null);
		setAuthPending(true);
		try {
			const response = await fetch("/api/v1/auth/continue", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ flowId: authFlow.flowId, value: authResponse }),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioAuthContinueResponse;
			if (body.flowId !== authFlow.flowId || !body.accepted)
				throw new Error("Studio did not accept the authentication response.");
			setAuthResponse("");
		} catch (reason) {
			setProviderError(
				reason instanceof Error ? reason.message : "Studio could not send the authentication response.",
			);
		} finally {
			setAuthPending(false);
		}
	};

	const acquireControl = async (studioSessionId: string): Promise<boolean> => {
		if (controlPendingId !== null) return false;
		setSessionError(null);
		setControlPendingId(studioSessionId);
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/lease`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ holderId, ttlMs: 45_000 }),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioControlLeaseResponse;
			setLeaseExpiresAtMs(current => ({ ...current, [studioSessionId]: body.lease.expiresAtMs }));
			setSelectedSessionId(studioSessionId);
			return true;
		} catch (reason) {
			setSessionError(
				reason instanceof Error ? reason.message : "Studio could not acquire control of this session.",
			);
			return false;
		} finally {
			setControlPendingId(null);
		}
	};

	const createSession = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (sessionPending || !sessionWorkspaceId || !sessionProviderId || !sessionModelId) return;
		setSessionError(null);
		setSessionPending(true);
		try {
			const name = sessionName.trim();
			const response = await fetch("/api/v1/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					holderId,
					modelId: sessionModelId,
					provider: sessionProviderId,
					workspaceId: sessionWorkspaceId,
					...(name ? { name } : {}),
				}),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioSessionResponse;
			setSessions(current =>
				sortSessions([body.session, ...current.filter(session => session.id !== body.session.id)]),
			);
			setSelectedSessionId(body.session.id);
			setSessionName("");
		} catch (reason) {
			setSessionError(reason instanceof Error ? reason.message : "Studio could not start the local OMP session.");
		} finally {
			setSessionPending(false);
		}
	};

	const submitPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		const message = promptText.trim();
		if (!selectedSession || !message || promptPending) return;
		if (!(await acquireControl(selectedSession.id))) return;
		setSessionError(null);
		setPromptPending(true);
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(selectedSession.id)}/prompts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ holderId, message }),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioPromptResponse;
			setSessions(current =>
				sortSessions([body.session, ...current.filter(session => session.id !== body.session.id)]),
			);
			setPromptText("");
		} catch (reason) {
			setSessionError(reason instanceof Error ? reason.message : "Studio could not send the prompt to OMP.");
		} finally {
			setPromptPending(false);
		}
	};

	const cancelActiveRun = async (): Promise<void> => {
		const run = selectedSession?.activeRun;
		if (!selectedSession || !run || promptPending) return;
		if (!(await acquireControl(selectedSession.id))) return;
		setSessionError(null);
		setPromptPending(true);
		try {
			const response = await fetch(`/api/v1/runs/${encodeURIComponent(run.id)}/cancel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ holderId }),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioRunResponse;
			setSessions(current =>
				sortSessions(
					current.map(session =>
						session.id === selectedSession.id ? { ...session, activeRun: body.run, status: "running" } : session,
					),
				),
			);
		} catch (reason) {
			setSessionError(reason instanceof Error ? reason.message : "Studio could not cancel the active OMP run.");
		} finally {
			setPromptPending(false);
		}
	};

	const resolveToolApproval = async (approval: StudioApproval, decision: "approve" | "reject"): Promise<void> => {
		if (approval.status !== "pending" || approvalPendingId !== null) return;
		if (!(await acquireControl(approval.studioSessionId))) return;
		setSessionError(null);
		setApprovalPendingId(approval.id);
		try {
			const response = await fetch(`/api/v1/approvals/${encodeURIComponent(approval.id)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ decision, holderId }),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioApprovalResponse;
			if (body.approval.id !== approval.id) throw new Error("Studio resolved an unexpected tool approval.");
			setApprovalsBySession(current => ({
				...current,
				[approval.studioSessionId]: upsertApproval(current[approval.studioSessionId] ?? [], body.approval),
			}));
		} catch (reason) {
			setSessionError(reason instanceof Error ? reason.message : "Studio could not resolve the tool approval.");
		} finally {
			setApprovalPendingId(null);
		}
	};

	const loadOlderAuditEntries = async (): Promise<void> => {
		if (!selectedSessionId || auditNextBeforeId === null || auditPending) return;
		setAuditPending(true);
		setAuditError(null);
		try {
			const body = await requestAuditEntries(selectedSessionId, auditNextBeforeId);
			setAuditEntries(current => {
				const existingIds = new Set(current.map(entry => entry.id));
				return [...current, ...body.entries.filter(entry => !existingIds.has(entry.id))];
			});
			setAuditNextBeforeId(body.nextBeforeId ?? null);
		} catch (reason) {
			setAuditError(reason instanceof Error ? reason.message : "Studio could not load older audit records.");
		} finally {
			setAuditPending(false);
		}
	};

	return (
		<div className="studio-shell">
			<div className="studio-orbit studio-orbit-one" />
			<div className="studio-orbit studio-orbit-two" />
			<header className="studio-header">
				<a className="studio-mark" href="/" aria-label="OMP Studio home">
					<span className="studio-mark-kicker">OMP</span>
					<span>Studio</span>
				</a>
				<div className={`studio-connection studio-connection-${connection}`}>
					<span className="studio-connection-dot" />
					{connection === "ready" ? "local link live" : connection === "offline" ? "reconnecting" : "connecting"}
				</div>
			</header>

			<main className="studio-main">
				<section className="studio-hero">
					<p className="studio-eyebrow">LOCAL COMMAND CENTER</p>
					<h1>One focused place for your OMP sessions.</h1>
					<p className="studio-lede">
						The Studio shell is running on this machine. It will keep OMP credentials, models, and session history
						in their native home while adding a deliberate browser control plane.
					</p>
					<div className="studio-profile-card">
						<div>
							<span className="studio-label">ACTIVE PROFILE</span>
							<strong>{profile}</strong>
						</div>
						<span className={profileReady ? "studio-state studio-state-ready" : "studio-state"}>
							{profileReady ? "ready" : "checking"}
						</span>
					</div>
				</section>

				<section className="studio-grid" aria-label="Studio roadmap status">
					<article className="studio-card studio-card-primary">
						<span className="studio-card-index">01</span>
						<h2>Local access</h2>
						<p>Loopback-only server, one-time handoff URL, and a process-scoped browser session are active.</p>
						<span className="studio-card-status">ONLINE</span>
					</article>
					<article className="studio-card">
						<span className="studio-card-index">02</span>
						<h2>Workspace ledger</h2>
						<p>Register one local directory once, then use its opaque Studio ID for every future session.</p>
						<span className="studio-card-status">ONLINE</span>
					</article>
					<article className="studio-card">
						<span className="studio-card-index">03</span>
						<h2>Provider bridge</h2>
						<p>OAuth, API-key, and local-engine setup reuse OMP AuthStorage rather than build a second vault.</p>
						<span
							className={
								providerOnboarding ? "studio-card-status" : "studio-card-status studio-card-status-next"
							}
						>
							{providerOnboarding ? "ONLINE" : "UNAVAILABLE"}
						</span>
					</article>
				</section>

				<section className="studio-workspace-panel" aria-labelledby="studio-workspaces-heading">
					<div className="studio-workspace-heading">
						<div>
							<p className="studio-eyebrow">WORKSPACE LEDGER</p>
							<h2 id="studio-workspaces-heading">Choose the directories Studio may use later.</h2>
						</div>
						<span>{workspaces.length} registered</span>
					</div>
					<form className="studio-workspace-form" onSubmit={registerWorkspace}>
						<label>
							<span>DIRECTORY</span>
							<input
								autoComplete="off"
								disabled={workspacePending}
								name="workspace-path"
								onChange={event => setWorkspacePath(event.target.value)}
								placeholder="C:\\Projects\\my-app"
								required
								value={workspacePath}
							/>
						</label>
						<label>
							<span>LABEL (OPTIONAL)</span>
							<input
								autoComplete="off"
								disabled={workspacePending}
								name="workspace-label"
								onChange={event => setWorkspaceLabel(event.target.value)}
								placeholder="My app"
								value={workspaceLabel}
							/>
						</label>
						<button type="submit" disabled={workspacePending}>
							{workspacePending ? "saving" : "register directory"}
						</button>
					</form>
					<p className="studio-workspace-caption">
						Studio canonicalizes this directory locally and keeps its full path off the API surface.
					</p>
					{workspaceError && <p className="studio-error studio-workspace-error">{workspaceError}</p>}
					<div className="studio-workspace-list">
						{workspaces.length === 0 ? (
							<p className="studio-workspace-empty">No directories registered yet.</p>
						) : (
							workspaces.map(workspace => (
								<article className="studio-workspace-row" key={workspace.id}>
									<div>
										<strong>{workspace.label}</strong>
										<span>
											{workspace.id.slice(0, 12)} / registered {formatWorkspaceDate(workspace.createdAtMs)}
										</span>
									</div>
									<button
										aria-label={`Remove ${workspace.label}`}
										disabled={workspacePending}
										onClick={() => void removeWorkspace(workspace.id)}
										type="button"
									>
										remove
									</button>
								</article>
							))
						)}
					</div>
				</section>

				{providerOnboarding && (
					<section className="studio-provider-panel" aria-labelledby="studio-providers-heading">
						<div className="studio-provider-heading">
							<div>
								<p className="studio-eyebrow">OMP PROVIDER BRIDGE</p>
								<h2 id="studio-providers-heading">Connect once. OMP keeps the credential.</h2>
							</div>
							<span>{providers.length} providers</span>
						</div>
						<p className="studio-provider-caption">
							Studio only relays the native OMP sign-in flow. API keys and OAuth tokens never enter the Studio
							database.
						</p>
						{providerError && <p className="studio-error studio-provider-error">{providerError}</p>}
						<div className="studio-provider-list">
							{providers.length === 0 ? (
								<p className="studio-workspace-empty">
									No configured or connectable OMP providers are available yet.
								</p>
							) : (
								providers.map(provider => (
									<article className="studio-provider-row" key={provider.id}>
										<div className="studio-provider-copy">
											<div className="studio-provider-title">
												<strong>{provider.name}</strong>
												<span
													className={`studio-provider-state studio-provider-state-${provider.authState}`}
												>
													{providerState(provider)}
												</span>
											</div>
											<p>
												{provider.models.length === 0
													? "No model is available until OMP finishes provider discovery."
													: `${provider.models.length} model${provider.models.length === 1 ? "" : "s"} currently available.`}
											</p>
											{provider.models.length > 0 && (
												<div className="studio-model-list" aria-label={`${provider.name} available models`}>
													{provider.models.slice(0, 4).map(model => (
														<span key={`${model.providerId}/${model.id}`}>{model.name}</span>
													))}
													{provider.models.length > 4 && <span>+{provider.models.length - 4} more</span>}
												</div>
											)}
										</div>
										{provider.canLogin && (
											<button
												disabled={providerPending !== null}
												onClick={() => void startProviderLogin(provider)}
												type="button"
											>
												{providerPending === provider.id ? "connecting" : "connect"}
											</button>
										)}
									</article>
								))
							)}
						</div>
						{authFlow && (
							<section className="studio-auth-flow" aria-live="polite">
								<div>
									<span className="studio-label">{authFlow.providerId}</span>
									<strong>
										{authFlow.phase === "completed"
											? "Provider connected"
											: authFlow.phase === "failed"
												? "Provider sign-in stopped"
												: "Provider sign-in in progress"}
									</strong>
									{authFlow.message && <p>{authFlow.message}</p>}
									{authFlow.instructions && <p>{authFlow.instructions}</p>}
								</div>
								{authFlow.authorizationUrl && (
									<a href={authFlow.launchUrl ?? authFlow.authorizationUrl} rel="noreferrer" target="_blank">
										open provider sign-in
									</a>
								)}
								{authFlow.phase === "prompt" && authFlow.prompt && (
									<form className="studio-auth-form" onSubmit={submitAuthResponse}>
										<label>
											<span>{authFlow.prompt.message}</span>
											<input
												autoComplete="off"
												disabled={authPending}
												onChange={event => setAuthResponse(event.target.value)}
												placeholder={authFlow.prompt.placeholder}
												required={!authFlow.prompt.allowEmpty}
												type={promptNeedsSecretInput(authFlow) ? "password" : "text"}
												value={authResponse}
											/>
										</label>
										<button disabled={authPending} type="submit">
											{authPending ? "sending" : "continue"}
										</button>
									</form>
								)}
							</section>
						)}
					</section>
				)}

				{rpcSupervisor && (
					<section className="studio-session-panel" aria-labelledby="studio-sessions-heading">
						<div className="studio-session-heading">
							<div>
								<p className="studio-eyebrow">OMP RPC SESSIONS</p>
								<h2 id="studio-sessions-heading">Start a local session, then keep its control deliberate.</h2>
							</div>
							<span>{sessions.length} sessions</span>
						</div>
						<p className="studio-session-caption">
							Each browser tab has a short-lived control lease. Studio renews it before sending a prompt or
							cancel request.
						</p>
						<form className="studio-session-form" onSubmit={createSession}>
							<label>
								<span>WORKSPACE</span>
								<select
									disabled={sessionPending || workspaces.length === 0}
									onChange={event => setSessionWorkspaceId(event.target.value)}
									value={sessionWorkspaceId}
								>
									<option value="">Choose a registered workspace</option>
									{workspaces.map(workspace => (
										<option key={workspace.id} value={workspace.id}>
											{workspace.label}
										</option>
									))}
								</select>
							</label>
							<label>
								<span>PROVIDER</span>
								<select
									disabled={sessionPending || providers.every(provider => provider.models.length === 0)}
									onChange={event => setSessionProviderId(event.target.value)}
									value={sessionProviderId}
								>
									<option value="">Choose a provider</option>
									{providers
										.filter(provider => provider.models.length > 0)
										.map(provider => (
											<option key={provider.id} value={provider.id}>
												{provider.name}
											</option>
										))}
								</select>
							</label>
							<label>
								<span>MODEL</span>
								<select
									disabled={sessionPending || selectedProviderModels.length === 0}
									onChange={event => setSessionModelId(event.target.value)}
									value={sessionModelId}
								>
									<option value="">Choose a model</option>
									{selectedProviderModels.map(model => (
										<option key={model.id} value={model.id}>
											{model.name}
										</option>
									))}
								</select>
							</label>
							<label>
								<span>NAME (OPTIONAL)</span>
								<input
									autoComplete="off"
									disabled={sessionPending}
									onChange={event => setSessionName(event.target.value)}
									placeholder="Release planning"
									value={sessionName}
								/>
							</label>
							<button
								disabled={
									sessionPending ||
									!sessionWorkspaceId ||
									!sessionProviderId ||
									!sessionModelId ||
									connection === "offline"
								}
								type="submit"
							>
								{sessionPending ? "starting" : "start session"}
							</button>
						</form>
						{sessionError && <p className="studio-error studio-session-error">{sessionError}</p>}

						<div className="studio-session-list">
							{sessions.length === 0 ? (
								<p className="studio-workspace-empty">
									Choose a workspace and OMP model above to start the first supervised session.
								</p>
							) : (
								sessions.map(session => {
									const hasLease = (leaseExpiresAtMs[session.id] ?? 0) > Date.now();
									return (
										<article
											className={
												session.id === selectedSessionId
													? "studio-session-row studio-session-row-selected"
													: "studio-session-row"
											}
											key={session.id}
										>
											<button
												className="studio-session-select"
												onClick={() => setSelectedSessionId(session.id)}
												type="button"
											>
												<span className="studio-session-name">
													{session.name ?? `Session ${session.id.slice(4, 12)}`}
												</span>
												<span className="studio-session-meta">
													{session.model
														? `${session.model.provider}/${session.model.id}`
														: "model unavailable"}{" "}
													/ {session.status}
												</span>
											</button>
											<button
												className={
													hasLease
														? "studio-session-control studio-session-control-active"
														: "studio-session-control"
												}
												disabled={controlPendingId !== null}
												onClick={() => void acquireControl(session.id)}
												type="button"
											>
												{controlPendingId === session.id
													? "claiming"
													: hasLease
														? "renew control"
														: "take control"}
											</button>
										</article>
									);
								})
							)}
						</div>

						{selectedSession && (
							<section
								className="studio-composer"
								aria-label={`Prompt ${selectedSession.name ?? selectedSession.id}`}
							>
								<div className="studio-composer-heading">
									<div>
										<span className="studio-label">ACTIVE SESSION</span>
										<strong>{selectedSession.name ?? `Session ${selectedSession.id.slice(4, 12)}`}</strong>
									</div>
									<span className={`studio-session-status studio-session-status-${selectedSession.status}`}>
										{selectedSession.status}
									</span>
								</div>
								<form className="studio-prompt-form" onSubmit={submitPrompt}>
									<label>
										<span>MESSAGE TO OMP</span>
										<textarea
											disabled={promptPending || controlPendingId !== null}
											onChange={event => setPromptText(event.target.value)}
											placeholder="Describe the next piece of work..."
											rows={4}
											value={promptText}
										/>
									</label>
									<div className="studio-prompt-actions">
										<button
											disabled={promptPending || controlPendingId !== null || !promptText.trim()}
											type="submit"
										>
											{promptPending ? "sending" : "send prompt"}
										</button>
										{selectedSession.activeRun && (
											<button
												className="studio-cancel-button"
												disabled={promptPending || controlPendingId !== null}
												onClick={() => void cancelActiveRun()}
												type="button"
											>
												cancel run
											</button>
										)}
									</div>
								</form>
								{usageSummary && (
									<section className="studio-usage-panel" aria-label="Session usage summary">
										<div className="studio-detail-heading">
											<span className="studio-label">SESSION USAGE</span>
											<span>{selectedSession.usage ? "latest OMP totals" : "waiting for OMP activity"}</span>
										</div>
										{selectedSession.usage ? (
											<dl className="studio-usage-grid">
												<div>
													<dt>total tokens</dt>
													<dd>{formatCount(selectedSession.usage.totalTokens)}</dd>
												</div>
												<div>
													<dt>input / output</dt>
													<dd>
														{formatCount(selectedSession.usage.inputTokens)} /{" "}
														{formatCount(selectedSession.usage.outputTokens)}
													</dd>
												</div>
												<div>
													<dt>tool calls</dt>
													<dd>{formatCount(selectedSession.usage.toolCalls)}</dd>
												</div>
												<div>
													<dt>cost</dt>
													<dd>${formatCost(selectedSession.usage.cost)}</dd>
												</div>
												{selectedSession.usage.contextTokens !== undefined &&
													selectedSession.usage.contextWindow !== undefined && (
														<div>
															<dt>context</dt>
															<dd>
																{formatCount(selectedSession.usage.contextTokens)} /{" "}
																{formatCount(selectedSession.usage.contextWindow)}
															</dd>
														</div>
													)}
											</dl>
										) : (
											<p className="studio-detail-empty">
												Usage appears after OMP completes a model response.
											</p>
										)}
									</section>
								)}
								{approvalControls && (
									<section className="studio-approval-panel" aria-live="polite">
										<div className="studio-detail-heading">
											<span className="studio-label">TOOL APPROVALS</span>
											<span>
												{selectedApprovals.filter(approval => approval.status === "pending").length} waiting
											</span>
										</div>
										{selectedApprovals.length === 0 ? (
											<p className="studio-detail-empty">
												Approvals appear only when OMP pauses an approval-required tool call.
											</p>
										) : (
											<div className="studio-approval-list">
												{selectedApprovals.map(approval => (
													<article
														className={`studio-approval-card studio-approval-card-${approval.status}`}
														key={approval.id}
													>
														<div className="studio-approval-copy">
															<div>
																<strong>{approval.toolName}</strong>
																<span
																	className={`studio-approval-status studio-approval-status-${approval.status}`}
																>
																	{approval.status}
																</span>
															</div>
															{approval.reason && <p>{approval.reason}</p>}
															<code>{approval.argumentsDigest}</code>
															<span>
																requested {new Date(approval.requestedAtMs).toLocaleTimeString()}
															</span>
														</div>
														{approval.status === "pending" && (
															<div className="studio-approval-actions">
																<button
																	disabled={approvalPendingId !== null || controlPendingId !== null}
																	onClick={() => void resolveToolApproval(approval, "approve")}
																	type="button"
																>
																	{approvalPendingId === approval.id ? "deciding" : "approve"}
																</button>
																<button
																	className="studio-approval-reject"
																	disabled={approvalPendingId !== null || controlPendingId !== null}
																	onClick={() => void resolveToolApproval(approval, "reject")}
																	type="button"
																>
																	reject
																</button>
															</div>
														)}
													</article>
												))}
											</div>
										)}
									</section>
								)}
								{subagentVisibility && (
									<section className="studio-subagent-panel" aria-label="Subagent status">
										<div className="studio-detail-heading">
											<span className="studio-label">SUBAGENTS</span>
											<span>{selectedSubagents.length} observed</span>
										</div>
										{selectedSubagents.length === 0 ? (
											<p className="studio-detail-empty">
												OMP will list delegated work here while a task is active.
											</p>
										) : (
											<div className="studio-subagent-list">
												{selectedSubagents.map(subagent => (
													<article className="studio-subagent-row" key={subagent.id}>
														<div>
															<strong>{subagent.agent}</strong>
															<span>{subagent.agentSource}</span>
														</div>
														<span
															className={`studio-subagent-status studio-subagent-status-${subagent.status}`}
														>
															{subagent.status}
														</span>
														<div className="studio-subagent-metrics">
															{subagent.requestCount !== undefined && (
																<span>{formatCount(subagent.requestCount)} requests</span>
															)}
															{subagent.tokenCount !== undefined && (
																<span>{formatCount(subagent.tokenCount)} tokens</span>
															)}
															{subagent.toolCount !== undefined && (
																<span>{formatCount(subagent.toolCount)} tools</span>
															)}
														</div>
													</article>
												))}
											</div>
										)}
									</section>
								)}
								{auditReview && (
									<section className="studio-audit-panel" aria-live="polite">
										<div className="studio-detail-heading">
											<span className="studio-label">LOCAL AUDIT</span>
											<span>{auditEntries.length} recent records</span>
										</div>
										{auditError && <p className="studio-detail-error">{auditError}</p>}
										{auditEntries.length === 0 ? (
											<p className="studio-detail-empty">
												{auditPending
													? "Loading the local control-plane ledger."
													: "No control-plane records for this session yet."}
											</p>
										) : (
											<ol className="studio-audit-list">
												{auditEntries.map(entry => {
													const detail = formatAuditDetail(entry);
													return (
														<li key={entry.id}>
															<div>
																<strong>{formatAuditAction(entry.action)}</strong>
																<span>{new Date(entry.occurredAtMs).toLocaleTimeString()}</span>
															</div>
															{detail && <p>{detail}</p>}
														</li>
													);
												})}
											</ol>
										)}
										{auditNextBeforeId !== null && (
											<button
												className="studio-audit-more"
												disabled={auditPending}
												onClick={() => void loadOlderAuditEntries()}
												type="button"
											>
												{auditPending ? "loading records" : "load older records"}
											</button>
										)}
									</section>
								)}
								<div className="studio-agent-stream" aria-live="polite">
									<div>
										<span className="studio-label">LIVE EVENT STREAM</span>
										<span>{selectedSessionEvents.length} recent events</span>
									</div>
									{selectedSessionEvents.length === 0 ? (
										<p>OMP events will appear here while this session works.</p>
									) : (
										<ol>
											{selectedSessionEvents.map(event => (
												<li
													className={
														event.toolName
															? "studio-agent-event studio-agent-event-tool"
															: "studio-agent-event"
													}
													key={event.sequence}
												>
													<span>{new Date(event.emittedAtMs).toLocaleTimeString()}</span>
													<p>
														{event.toolName && <strong>{event.toolName}</strong>}
														{event.summary}
													</p>
												</li>
											))}
										</ol>
									)}
								</div>
							</section>
						)}
					</section>
				)}

				<section className="studio-note">
					<div className="studio-note-rule" />
					<div>
						<span className="studio-label">{rpcSupervisor ? "MVP READY" : "NEXT PHASE"}</span>
						<p>
							{rpcSupervisor
								? "Sessions, approvals, usage, reconnect recovery, and the local audit ledger are ready on this machine."
								: "The provider bridge is live before chat controls appear. Start Studio through OMP to enable supervised local sessions."}
						</p>
					</div>
				</section>

				{error && <p className="studio-error">{error}</p>}
			</main>

			<footer className="studio-footer">
				<span>OMP STUDIO / LOCAL SINGLE-USER</span>
				<span>REST v1 + WS v1</span>
			</footer>
		</div>
	);
}
