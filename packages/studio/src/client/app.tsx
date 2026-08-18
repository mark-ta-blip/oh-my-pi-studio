import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	StudioApproval,
	StudioApprovalListResponse,
	StudioApprovalResponse,
	StudioAuthCancelResponse,
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
	StudioTranscriptMessage,
	StudioTranscriptResponse,
	StudioUsage,
	StudioWorkspace,
	StudioWorkspaceListResponse,
	StudioWorkspaceResponse,
} from "../protocol";
import { mergeStudioAuthProgress } from "./auth-flow";
import { isActiveRun, isTerminalRunStatus, mergeStudioSessionSnapshot, reconcileStudioSession } from "./session-state";
import { mergeStudioTranscriptSnapshot, upsertStudioTranscriptMessage } from "./transcript-state";

type ConnectionState = "connecting" | "ready" | "offline";

const STUDIO_MUTATION_TIMEOUT_MS = 30_000;

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
	url.searchParams.set("after", String(afterSequence));
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

function isActiveAuthFlow(progress: StudioAuthProgress): boolean {
	return progress.phase === "authorization" || progress.phase === "progress" || progress.phase === "prompt";
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

const selectedSessionStorageKey = "omp-studio-selected-session";

function loadStoredSessionId(): string | null {
	try {
		const value = localStorage.getItem(selectedSessionStorageKey);
		return value && value.length <= 256 ? value : null;
	} catch {
		return null;
	}
}

function persistSelectedSessionId(sessionId: string | null): void {
	try {
		if (sessionId) localStorage.setItem(selectedSessionStorageKey, sessionId);
		else localStorage.removeItem(selectedSessionStorageKey);
	} catch {
		// The desktop shell continues normally when browser storage is unavailable.
	}
}

function isStudioTranscriptMessage(value: unknown): value is StudioTranscriptMessage {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.studioSessionId === "string" &&
		typeof value.text === "string" &&
		typeof value.createdAtMs === "number" &&
		typeof value.updatedAtMs === "number" &&
		typeof value.role === "string" &&
		["user", "assistant"].includes(value.role) &&
		typeof value.status === "string" &&
		["streaming", "completed", "failed", "interrupted"].includes(value.status) &&
		typeof value.runId === "string"
	);
}

function parseTranscriptUpdated(
	message: unknown,
): message is StudioEventEnvelope<StudioTranscriptMessage> & { studioSessionId: string } {
	if (!isRecord(message)) return false;
	return (
		message.type === "transcript.updated" &&
		typeof message.studioSessionId === "string" &&
		isStudioTranscriptMessage(message.data)
	);
}

function sessionTitle(session: StudioSession): string {
	return session.name ?? `Session ${session.id.slice(4, 12)}`;
}

function formatShortTime(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function transcriptDisplayText(message: StudioTranscriptMessage): string {
	if (message.text) return message.text;
	if (message.role !== "assistant") return "";
	if (message.status === "failed") return "OMP could not complete this response.";
	if (message.status === "interrupted") return "OMP stopped this response.";
	return "";
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
	const [workspacePickerPending, setWorkspacePickerPending] = useState(false);
	const [providers, setProviders] = useState<StudioProvider[]>([]);
	const [providerError, setProviderError] = useState<string | null>(null);
	const [providerPending, setProviderPending] = useState<string | null>(null);
	const [authFlow, setAuthFlow] = useState<StudioAuthProgress | null>(null);
	const [authResponse, setAuthResponse] = useState("");
	const [authPending, setAuthPending] = useState(false);
	const [authBrowserPending, setAuthBrowserPending] = useState(false);
	const [authCancelPending, setAuthCancelPending] = useState(false);
	const [holderId] = useState(createHolderId);
	const [sessions, setSessions] = useState<StudioSession[]>([]);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [sessionName, setSessionName] = useState("");
	const [sessionWorkspaceId, setSessionWorkspaceId] = useState("");
	const [sessionProviderId, setSessionProviderId] = useState("");
	const [sessionModelId, setSessionModelId] = useState("");
	const [sessionPending, setSessionPending] = useState(false);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(loadStoredSessionId);
	const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
	const [promptPending, setPromptPending] = useState(false);
	const [cancelPending, setCancelPending] = useState(false);
	const [transcriptBySession, setTranscriptBySession] = useState<Record<string, StudioTranscriptMessage[]>>({});
	const [transcriptErrorsBySession, setTranscriptErrorsBySession] = useState<Record<string, string>>({});
	const [transcriptLoadingBySession, setTranscriptLoadingBySession] = useState<Record<string, boolean>>({});
	const setupAutoOpenedRef = useRef(false);
	const [setupOpen, setSetupOpen] = useState(() => {
		const shouldOpen = loadStoredSessionId() === null;
		setupAutoOpenedRef.current = shouldOpen;
		return shouldOpen;
	});
	const [controlPendingId, setControlPendingId] = useState<string | null>(null);
	const [leaseExpiresAtMs, setLeaseExpiresAtMs] = useState<Record<string, number>>({});
	const [agentEventsBySession, setAgentEventsBySession] = useState<Record<string, StudioAgentEventItem[]>>({});
	const [approvalPendingId, setApprovalPendingId] = useState<string | null>(null);
	const [approvalsBySession, setApprovalsBySession] = useState<Record<string, StudioApproval[]>>({});
	const [subagentsBySession, setSubagentsBySession] = useState<Record<string, StudioSubagent[]>>({});
	const [resyncRevision, setResyncRevision] = useState(0);
	const lastEventSequenceRef = useRef(0);
	const autoOpenedAuthFlowIdsRef = useRef(new Set<string>());
	const conversationScrollRef = useRef<HTMLElement>(null);
	const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
	const workspacePathRef = useRef<HTMLInputElement>(null);
	const sessionNameRef = useRef<HTMLInputElement>(null);
	const notifiedRunIdsRef = useRef(new Set<string>());
	const runStateBySessionRef = useRef(new Map<string, StudioRun>());
	const sessionSnapshotVersionRef = useRef(0);
	const transcriptRequestIdsRef = useRef(new Map<string, number>());
	const conversationScrollFrameRef = useRef<number | undefined>(undefined);
	const shouldAutoScrollConversationRef = useRef(true);
	const openSetup = useCallback((): void => {
		setupAutoOpenedRef.current = false;
		setSetupOpen(true);
	}, []);

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
		const snapshotVersion = sessionSnapshotVersionRef.current;
		setSessionError(null);
		try {
			const response = await fetch("/api/v1/sessions");
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioSessionListResponse;
			const snapshot = body.sessions.map(session => {
				const reconciled = reconcileStudioSession(session, undefined, runStateBySessionRef.current.get(session.id));
				if (reconciled.run) runStateBySessionRef.current.set(session.id, reconciled.run);
				else runStateBySessionRef.current.delete(session.id);
				return reconciled.session;
			});
			setSessions(current => {
				if (sessionSnapshotVersionRef.current === snapshotVersion) return sortSessions(snapshot);
				const snapshotById = new Map(snapshot.map(session => [session.id, session]));
				const merged = current.map(session => {
					const next = snapshotById.get(session.id);
					if (!next) return session;
					snapshotById.delete(session.id);
					return mergeStudioSessionSnapshot(session, next);
				});
				return sortSessions([...merged, ...snapshotById.values()]);
			});
		} catch (reason) {
			setSessionError(reason instanceof Error ? reason.message : "Studio could not load local sessions.");
		}
	}, []);

	const loadTranscript = useCallback(async (studioSessionId: string): Promise<void> => {
		const requestId = (transcriptRequestIdsRef.current.get(studioSessionId) ?? 0) + 1;
		transcriptRequestIdsRef.current.set(studioSessionId, requestId);
		setTranscriptErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		setTranscriptLoadingBySession(current => ({ ...current, [studioSessionId]: true }));
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/transcript`);
			if (transcriptRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (response.status === 404) {
				setTranscriptBySession(current => ({ ...current, [studioSessionId]: current[studioSessionId] ?? [] }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioTranscriptResponse;
			if (transcriptRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setTranscriptBySession(current => ({
				...current,
				[studioSessionId]: mergeStudioTranscriptSnapshot(current[studioSessionId] ?? [], body.messages),
			}));
		} catch (reason) {
			if (transcriptRequestIdsRef.current.get(studioSessionId) === requestId) {
				setTranscriptErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load this conversation.",
				}));
			}
		} finally {
			if (transcriptRequestIdsRef.current.get(studioSessionId) === requestId) {
				setTranscriptLoadingBySession(current => ({ ...current, [studioSessionId]: false }));
			}
		}
	}, []);

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
		if (!setupAutoOpenedRef.current || sessions.length === 0) return;
		setupAutoOpenedRef.current = false;
		setSetupOpen(false);
	}, [sessions.length]);

	useEffect(() => {
		persistSelectedSessionId(selectedSessionId);
	}, [selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId) {
			return;
		}
		void loadTranscript(selectedSessionId);
	}, [loadTranscript, resyncRevision, selectedSessionId]);

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
		if (!authFlow || providerPending === null || !isActiveAuthFlow(authFlow) || !window.ompStudio) return;
		const authorizationUrl = authFlow.launchUrl ?? authFlow.authorizationUrl;
		if (!authorizationUrl || autoOpenedAuthFlowIdsRef.current.has(authFlow.flowId)) return;
		autoOpenedAuthFlowIdsRef.current.add(authFlow.flowId);
		void window.ompStudio.openExternal(authorizationUrl).catch(reason => {
			setProviderError(
				reason instanceof Error ? reason.message : "Studio could not open the provider sign-in page.",
			);
		});
	}, [authFlow, providerPending]);

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

		function closeSocket(socket: WebSocket): void {
			try {
				if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
			} catch {
				// A failed browser socket can transition to CLOSED between the state check and close call.
			}
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
						setAgentEventsBySession({});
						setApprovalsBySession({});
						setSubagentsBySession({});
						setTranscriptBySession({});
						setTranscriptErrorsBySession({});
						setTranscriptLoadingBySession({});
						runStateBySessionRef.current.clear();
						setResyncRevision(current => current + 1);
						return;
					}
					if (sequence <= lastEventSequenceRef.current) return;
					lastEventSequenceRef.current = sequence;
					if (parseAuthProgress(message)) {
						const progress = message.data;
						setAuthFlow(current => mergeStudioAuthProgress(current, progress));
						if (progress.phase === "completed" || progress.phase === "failed" || progress.phase === "cancelled") {
							setProviderPending(null);
							setAuthPending(false);
							setAuthBrowserPending(false);
							setAuthCancelPending(false);
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
						runStateBySessionRef.current.set(message.studioSessionId, run);
						sessionSnapshotVersionRef.current += 1;
						if (isTerminalRunStatus(run.status) && !notifiedRunIdsRef.current.has(run.id)) {
							notifiedRunIdsRef.current.add(run.id);
							const title = run.status === "failed" ? "OMP run needs attention" : "OMP run finished";
							const body =
								run.status === "failed"
									? "Open Studio to review the run state."
									: "Your session is ready for the next prompt.";
							void window.ompStudio?.notify(title, body).catch(() => undefined);
						}
						setSessions(current =>
							sortSessions(
								current.map(session =>
									session.id === message.studioSessionId
										? reconcileStudioSession(session, run, run).session
										: session,
								),
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
						sessionSnapshotVersionRef.current += 1;
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
					if (parseTranscriptUpdated(message)) {
						setTranscriptBySession(current => ({
							...current,
							[message.studioSessionId]: upsertStudioTranscriptMessage(
								current[message.studioSessionId] ?? [],
								message.data,
							),
						}));
						return;
					}
					if (parseAgentEvent(message)) {
						const payload = message.data;
						setAgentEventsBySession(current => ({
							...current,
							[message.studioSessionId]: [
								{
									emittedAtMs: message.emittedAtMs,
									runId: message.runId,
									sequence,
									studioSessionId: message.studioSessionId,
									summary: summarizeAgentEvent(payload),
									...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
									type: payload.type,
								},
								...(current[message.studioSessionId] ?? []),
							].slice(0, 40),
						}));
					}
				} catch {
					setConnection("offline");
					if (socket.readyState === WebSocket.OPEN) socket.close(1002, "invalid Studio event");
				}
			});
			socket.addEventListener("error", () => {
				if (activeSocket !== socket) return;
				activeSocket = undefined;
				closeSocket(socket);
				scheduleReconnect();
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
			const socket = activeSocket;
			activeSocket = undefined;
			if (socket) closeSocket(socket);
		};
	}, [loadProviders]);

	const profile = bootstrap?.profile ?? "loading";
	const providerOnboarding = bootstrap?.features.providerOnboarding === true;
	const rpcSupervisor = bootstrap?.features.rpcSupervisor === true;
	const approvalControls = bootstrap?.features.approvalControls === true;
	const subagentVisibility = bootstrap?.features.subagentVisibility === true;
	const usageSummary = bootstrap?.features.usageSummary === true;
	const selectedSession = useMemo(
		() => sessions.find(session => session.id === selectedSessionId) ?? null,
		[sessions, selectedSessionId],
	);
	const selectedProvider = useMemo(
		() => providers.find(provider => provider.id === sessionProviderId) ?? null,
		[providers, sessionProviderId],
	);
	const selectedProviderModels = selectedProvider?.models ?? [];
	const sessionStartBlockedReason =
		connection === "offline"
			? "Studio is reconnecting."
			: !sessionWorkspaceId
				? "Register a workspace to start a session."
				: !sessionProviderId || !sessionModelId
					? "Connect a provider with an available model to start a session."
					: null;
	const sessionStartLabel = sessionPending
		? "starting"
		: !sessionWorkspaceId
			? "choose project"
			: !sessionProviderId || !sessionModelId
				? "connect model"
				: "start session";
	const selectedSessionEvents = useMemo(
		() => (selectedSessionId ? (agentEventsBySession[selectedSessionId] ?? []) : []),
		[agentEventsBySession, selectedSessionId],
	);
	const selectedTranscript = selectedSessionId ? (transcriptBySession[selectedSessionId] ?? []) : [];
	const promptText = selectedSessionId ? (promptDrafts[selectedSessionId] ?? "") : "";
	const transcriptError = selectedSessionId ? (transcriptErrorsBySession[selectedSessionId] ?? null) : null;
	const transcriptLoading = selectedSessionId ? transcriptLoadingBySession[selectedSessionId] === true : false;
	const { displayedTranscript, hasStreamingAssistant } = useMemo(() => {
		let hasStreamingAssistant = false;
		const displayedTranscript = selectedTranscript.filter(message => {
			if (message.role === "assistant" && message.status === "streaming") hasStreamingAssistant = true;
			return message.role === "user" || message.text.length > 0 || message.status !== "streaming";
		});
		return { displayedTranscript, hasStreamingAssistant };
	}, [selectedTranscript]);
	const selectedApprovals = selectedSessionId ? (approvalsBySession[selectedSessionId] ?? []) : [];
	const selectedSubagents = selectedSessionId ? (subagentsBySession[selectedSessionId] ?? []) : [];
	const selectedActiveRun = isActiveRun(selectedSession?.activeRun) ? selectedSession.activeRun : undefined;
	const selectedWorkspace = useMemo(
		() => workspaces.find(workspace => workspace.id === selectedSession?.workspaceId) ?? null,
		[selectedSession?.workspaceId, workspaces],
	);
	const pendingApprovalCount = selectedApprovals.filter(approval => approval.status === "pending").length;
	const composerBlocked =
		promptPending || cancelPending || controlPendingId !== null || selectedActiveRun !== undefined;

	const registerWorkspacePath = async (path: string): Promise<void> => {
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
			setSessionWorkspaceId(body.workspace.id);
			setWorkspaceLabel("");
			setWorkspacePath("");
		} catch (reason) {
			setWorkspaceError(reason instanceof Error ? reason.message : "Studio could not register the workspace.");
		} finally {
			setWorkspacePending(false);
		}
	};

	const registerWorkspace = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		await registerWorkspacePath(workspacePath.trim());
	};

	const selectWorkspace = async (): Promise<void> => {
		const desktopApi = window.ompStudio;
		if (!desktopApi) {
			setWorkspaceError("The desktop folder picker is unavailable. Restart OMP Studio and try again.");
			return;
		}
		if (workspacePending || workspacePickerPending) return;
		setWorkspaceError(null);
		setWorkspacePickerPending(true);
		try {
			const selectedPath = await desktopApi.selectWorkspace();
			if (selectedPath) await registerWorkspacePath(selectedPath);
		} catch (reason) {
			setWorkspaceError(reason instanceof Error ? reason.message : "Studio could not open the directory picker.");
		} finally {
			setWorkspacePickerPending(false);
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
		setAuthBrowserPending(false);
		setAuthCancelPending(false);
		setProviderPending(provider.id);
		try {
			const response = await fetch(`/api/v1/providers/${encodeURIComponent(provider.id)}/login`, { method: "POST" });
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioProviderLoginResponse;
			setAuthResponse("");
			setAuthFlow(current =>
				current?.flowId === body.flowId
					? current
					: {
							flowId: body.flowId,
							providerId: body.providerId,
							phase: "progress",
							message: "Preparing provider sign-in...",
						},
			);
		} catch (reason) {
			setProviderPending(null);
			setProviderError(reason instanceof Error ? reason.message : "Studio could not start provider sign-in.");
		}
	};

	const cancelProviderLogin = async (): Promise<void> => {
		if (!authFlow || !isActiveAuthFlow(authFlow) || authCancelPending) return;
		setProviderError(null);
		setAuthCancelPending(true);
		try {
			const response = await fetch("/api/v1/auth/cancel", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ flowId: authFlow.flowId }),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioAuthCancelResponse;
			if (body.flowId !== authFlow.flowId || !body.cancelled) {
				throw new Error("Studio did not cancel the provider sign-in.");
			}
		} catch (reason) {
			setProviderError(reason instanceof Error ? reason.message : "Studio could not cancel the provider sign-in.");
		} finally {
			setAuthCancelPending(false);
		}
	};

	const openProviderAuthorization = async (): Promise<void> => {
		const authorizationUrl = authFlow?.launchUrl ?? authFlow?.authorizationUrl;
		if (!authorizationUrl || authBrowserPending) return;
		setProviderError(null);
		setAuthBrowserPending(true);
		try {
			if (window.ompStudio) {
				await window.ompStudio.openExternal(authorizationUrl);
				return;
			}
			if (!window.open(authorizationUrl, "_blank", "noopener,noreferrer")) {
				throw new Error("Studio could not open the provider sign-in page.");
			}
		} catch (reason) {
			setProviderError(
				reason instanceof Error ? reason.message : "Studio could not open the provider sign-in page.",
			);
		} finally {
			setAuthBrowserPending(false);
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

	const acquireControl = async (studioSessionId: string, selectSession = true): Promise<boolean> => {
		if (controlPendingId !== null) return false;
		setSessionError(null);
		setControlPendingId(studioSessionId);
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/lease`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ holderId, ttlMs: 45_000 }),
				signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioControlLeaseResponse;
			setLeaseExpiresAtMs(current => ({ ...current, [studioSessionId]: body.lease.expiresAtMs }));
			if (selectSession) setSelectedSessionId(studioSessionId);
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
		if (sessionPending) return;
		if (!sessionWorkspaceId) {
			setSessionError("Choose a project before starting a session.");
			openSetup();
			return;
		}
		if (!sessionProviderId || !sessionModelId) {
			setSessionError("Connect a provider and choose a model before starting a session.");
			openSetup();
			return;
		}
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
			sessionSnapshotVersionRef.current += 1;
			setSessions(current =>
				sortSessions([body.session, ...current.filter(session => session.id !== body.session.id)]),
			);
			setSelectedSessionId(body.session.id);
			setSessionName("");
			setSetupOpen(false);
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
		const studioSessionId = selectedSession.id;
		if (!(await acquireControl(studioSessionId, false))) return;
		setSessionError(null);
		setPromptPending(true);
		const optimisticMessageId = `local_${crypto.randomUUID().replaceAll("-", "")}`;
		const promptedAtMs = Date.now();
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/prompts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ holderId, message }),
				signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioPromptResponse;
			const reconciled = reconcileStudioSession(
				body.session,
				body.run,
				runStateBySessionRef.current.get(studioSessionId),
			);
			if (reconciled.run) runStateBySessionRef.current.set(studioSessionId, reconciled.run);
			sessionSnapshotVersionRef.current += 1;
			setSessions(current =>
				sortSessions([reconciled.session, ...current.filter(session => session.id !== reconciled.session.id)]),
			);
			setTranscriptBySession(current => ({
				...current,
				[studioSessionId]: upsertStudioTranscriptMessage(current[studioSessionId] ?? [], {
					id: optimisticMessageId,
					studioSessionId,
					runId: body.run.id,
					role: "user",
					text: message,
					status: "completed",
					createdAtMs: promptedAtMs,
					updatedAtMs: Date.now(),
				}),
			}));
			setPromptDrafts(current => {
				const next = { ...current };
				delete next[studioSessionId];
				return next;
			});
		} catch (reason) {
			setTranscriptBySession(current => ({
				...current,
				[studioSessionId]: (current[studioSessionId] ?? []).filter(
					transcriptMessage => transcriptMessage.id !== optimisticMessageId,
				),
			}));
			void loadSessions();
			void loadTranscript(studioSessionId);
			setSessionError(reason instanceof Error ? reason.message : "Studio could not send the prompt to OMP.");
		} finally {
			setPromptPending(false);
		}
	};

	const cancelActiveRun = async (): Promise<void> => {
		const run = selectedActiveRun;
		if (!selectedSession || !run || cancelPending) return;
		const studioSessionId = selectedSession.id;
		if (!(await acquireControl(studioSessionId, false))) return;
		setSessionError(null);
		setCancelPending(true);
		try {
			const response = await fetch(`/api/v1/runs/${encodeURIComponent(run.id)}/cancel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ holderId }),
				signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioRunResponse;
			const observedRun = runStateBySessionRef.current.get(studioSessionId);
			sessionSnapshotVersionRef.current += 1;
			setSessions(current =>
				sortSessions(
					current.map(session => {
						if (session.id !== studioSessionId) return session;
						const reconciled = reconcileStudioSession(session, body.run, observedRun);
						if (reconciled.run) runStateBySessionRef.current.set(studioSessionId, reconciled.run);
						return reconciled.session;
					}),
				),
			);
		} catch (reason) {
			void loadSessions();
			setSessionError(reason instanceof Error ? reason.message : "Studio could not cancel the active OMP run.");
		} finally {
			setCancelPending(false);
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

	useEffect(() => {
		shouldAutoScrollConversationRef.current = true;
	}, [selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !shouldAutoScrollConversationRef.current) return;
		if (conversationScrollFrameRef.current !== undefined) return;
		conversationScrollFrameRef.current = window.requestAnimationFrame(() => {
			conversationScrollFrameRef.current = undefined;
			const conversation = conversationScrollRef.current;
			if (!conversation || !shouldAutoScrollConversationRef.current) return;
			conversation.scrollTop = conversation.scrollHeight;
		});
	}, [selectedSessionId, selectedTranscript]);

	useEffect(() => {
		return () => {
			if (conversationScrollFrameRef.current === undefined) return;
			window.cancelAnimationFrame(conversationScrollFrameRef.current);
			conversationScrollFrameRef.current = undefined;
		};
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (!event.ctrlKey && !event.metaKey) return;
			const key = event.key.toLowerCase();
			if (key === "n") {
				event.preventDefault();
				openSetup();
				window.requestAnimationFrame(() => sessionNameRef.current?.focus());
				return;
			}
			if (key === "o") {
				event.preventDefault();
				openSetup();
				if (window.ompStudio) void selectWorkspace();
				else window.requestAnimationFrame(() => workspacePathRef.current?.focus());
				return;
			}
			if (key === ",") {
				event.preventDefault();
				openSetup();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [openSetup, selectWorkspace]);

	return (
		<div className="studio-shell studio-desktop-shell">
			<header className="studio-titlebar">
				<a className="studio-mark" href="/" aria-label="OMP Studio home">
					<span className="studio-mark-kicker">OMP</span>
					<span>Studio</span>
				</a>
				<div className="studio-titlebar-context">
					<span>{selectedSession ? sessionTitle(selectedSession) : "Local workspace"}</span>
					<span className="studio-titlebar-profile">{profile}</span>
				</div>
				<div className="studio-titlebar-actions">
					<div className={`studio-connection studio-connection-${connection}`}>
						<span className="studio-connection-dot" />
						{connection === "ready" ? "connected" : connection === "offline" ? "reconnecting" : "connecting"}
					</div>
					<button className="studio-titlebar-button" onClick={openSetup} type="button">
						Setup
					</button>
				</div>
			</header>

			<div className="studio-workspace-layout">
				<aside className="studio-sidebar" aria-label="Projects and sessions">
					<div className="studio-sidebar-actions">
						<button className="studio-new-session" onClick={openSetup} type="button">
							+ New session
						</button>
						<button className="studio-sidebar-button" onClick={openSetup} type="button">
							Settings
						</button>
					</div>

					<section className="studio-sidebar-section" aria-labelledby="studio-projects-heading">
						<div className="studio-sidebar-heading">
							<h2 id="studio-projects-heading">Projects</h2>
							<button
								aria-label="Add project"
								onClick={() => {
									openSetup();
									window.requestAnimationFrame(() => workspacePathRef.current?.focus());
								}}
								type="button"
							>
								+
							</button>
						</div>
						<div className="studio-project-list">
							{workspaces.length === 0 ? (
								<p className="studio-sidebar-empty">No project folder yet.</p>
							) : (
								workspaces.map(workspace => (
									<button
										className={
											workspace.id === sessionWorkspaceId
												? "studio-project-row studio-project-row-selected"
												: "studio-project-row"
										}
										key={workspace.id}
										onClick={() => {
											setSessionWorkspaceId(workspace.id);
											openSetup();
										}}
										type="button"
									>
										<span>{workspace.label}</span>
										<small>{formatWorkspaceDate(workspace.updatedAtMs)}</small>
									</button>
								))
							)}
						</div>
					</section>

					<section
						className="studio-sidebar-section studio-sidebar-sessions"
						aria-labelledby="studio-sessions-heading"
					>
						<div className="studio-sidebar-heading">
							<h2 id="studio-sessions-heading">Sessions</h2>
							<span>{sessions.length}</span>
						</div>
						<div className="studio-session-list">
							{sessions.length === 0 ? (
								<p className="studio-sidebar-empty">Start a session to begin a conversation.</p>
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
												<span className="studio-session-name">{sessionTitle(session)}</span>
												<span className="studio-session-meta">
													{session.model ? session.model.id : "model unavailable"}
												</span>
											</button>
											<button
												aria-label={
													hasLease
														? `Renew control for ${sessionTitle(session)}`
														: `Take control of ${sessionTitle(session)}`
												}
												className={
													hasLease
														? "studio-session-control studio-session-control-active"
														: "studio-session-control"
												}
												disabled={controlPendingId !== null}
												onClick={() => void acquireControl(session.id)}
												type="button"
											>
												{controlPendingId === session.id ? "..." : hasLease ? "Control" : "Take"}
											</button>
										</article>
									);
								})
							)}
						</div>
					</section>

					<div className="studio-sidebar-footer">
						<span>OMP Studio</span>
						<span>Local only</span>
					</div>
				</aside>

				<main className="studio-conversation-pane" aria-label="Conversation">
					{selectedSession ? (
						<>
							<header className="studio-conversation-header">
								<div>
									<div className="studio-conversation-breadcrumb">
										<span>{selectedWorkspace?.label ?? "Project"}</span>
										<span>/</span>
										<span>{selectedSession.model?.provider ?? "OMP"}</span>
									</div>
									<h1>{sessionTitle(selectedSession)}</h1>
								</div>
								<div className="studio-conversation-header-actions">
									<span className={`studio-session-status studio-session-status-${selectedSession.status}`}>
										{selectedActiveRun ? "running" : selectedSession.status}
									</span>
									<button onClick={openSetup} type="button">
										Configure
									</button>
								</div>
							</header>

							<section
								aria-live="polite"
								className="studio-conversation-scroll"
								onScroll={event => {
									const conversation = event.currentTarget;
									shouldAutoScrollConversationRef.current =
										conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
								}}
								ref={conversationScrollRef}
							>
								{transcriptLoading && displayedTranscript.length === 0 && (
									<p className="studio-conversation-notice">Loading conversation...</p>
								)}
								{!transcriptLoading && displayedTranscript.length === 0 && !hasStreamingAssistant && (
									<div className="studio-empty-conversation">
										<span className="studio-empty-conversation-mark">OMP</span>
										<h2>Start the conversation</h2>
										<p>
											Send a task to this session. Replies and live updates stay here as the work progresses.
										</p>
									</div>
								)}
								{displayedTranscript.map(message => (
									<article className={`studio-message studio-message-${message.role}`} key={message.id}>
										<div className="studio-message-meta">
											<span>{message.role === "user" ? "You" : "OMP"}</span>
											<time dateTime={new Date(message.createdAtMs).toISOString()}>
												{formatShortTime(message.createdAtMs)}
											</time>
											{message.status === "streaming" && (
												<span className="studio-message-streaming">Streaming</span>
											)}
											{message.status === "failed" && <span className="studio-message-failed">Stopped</span>}
										</div>
										<p>{transcriptDisplayText(message)}</p>
									</article>
								))}
								{selectedActiveRun && hasStreamingAssistant && (
									<div className="studio-run-indicator">
										<span />
										OMP is working
									</div>
								)}
							</section>

							<form className="studio-composer" onSubmit={submitPrompt}>
								<label className="studio-composer-input">
									<span className="studio-sr-only">Message OMP</span>
									<textarea
										ref={composerTextareaRef}
										disabled={composerBlocked}
										onChange={event => {
											if (!selectedSessionId) return;
											setPromptDrafts(current => ({ ...current, [selectedSessionId]: event.target.value }));
										}}
										onKeyDown={event => {
											if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
												event.preventDefault();
												event.currentTarget.form?.requestSubmit();
											}
										}}
										placeholder={
											selectedActiveRun
												? "OMP is working on the current task"
												: "Message OMP about the next task"
										}
										rows={3}
										value={promptText}
									/>
								</label>
								<div className="studio-composer-footer">
									<span>{selectedActiveRun ? "Run in progress" : "Ctrl+Enter to send"}</span>
									<div>
										{selectedActiveRun && (
											<button
												className="studio-cancel-button"
												disabled={cancelPending || controlPendingId !== null}
												onClick={() => void cancelActiveRun()}
												type="button"
											>
												{cancelPending ? "Stopping" : "Stop"}
											</button>
										)}
										<button disabled={composerBlocked || !promptText.trim()} type="submit">
											{promptPending ? "Sending" : "Send"}
										</button>
									</div>
								</div>
							</form>
							{transcriptError && <p className="studio-inline-error">{transcriptError}</p>}
							{sessionError && <p className="studio-inline-error">{sessionError}</p>}
						</>
					) : (
						<section className="studio-no-session">
							<span className="studio-empty-conversation-mark">OMP</span>
							<h1>Open a focused session</h1>
							<p>Choose a local project and provider once, then work in a persistent conversation.</p>
							<button onClick={openSetup} type="button">
								New session
							</button>
							{sessionError && <p className="studio-inline-error">{sessionError}</p>}
						</section>
					)}
				</main>

				<aside className="studio-inspector" aria-label="Session inspector">
					<div className="studio-inspector-topline">
						<span>Inspector</span>
						<button onClick={openSetup} type="button">
							Setup
						</button>
					</div>

					{selectedSession ? (
						<>
							<section className="studio-inspector-section">
								<div className="studio-inspector-heading">
									<h2>Session</h2>
									<span className={`studio-session-status studio-session-status-${selectedSession.status}`}>
										{selectedActiveRun ? "active" : selectedSession.status}
									</span>
								</div>
								<dl className="studio-inspector-facts">
									<div>
										<dt>Project</dt>
										<dd>{selectedWorkspace?.label ?? "Unavailable"}</dd>
									</div>
									<div>
										<dt>Model</dt>
										<dd>
											{selectedSession.model
												? `${selectedSession.model.provider}/${selectedSession.model.id}`
												: "Unavailable"}
										</dd>
									</div>
									<div>
										<dt>Control</dt>
										<dd>
											{(leaseExpiresAtMs[selectedSession.id] ?? 0) > Date.now()
												? "Held by this window"
												: "Not held"}
										</dd>
									</div>
								</dl>
								<button
									className="studio-inspector-control"
									disabled={controlPendingId !== null}
									onClick={() => void acquireControl(selectedSession.id)}
									type="button"
								>
									{controlPendingId === selectedSession.id
										? "Claiming control"
										: (leaseExpiresAtMs[selectedSession.id] ?? 0) > Date.now()
											? "Renew control"
											: "Take control"}
								</button>
							</section>

							{usageSummary && (
								<section className="studio-inspector-section">
									<div className="studio-inspector-heading">
										<h2>Usage</h2>
										<span>{selectedSession.usage ? "Latest" : "Waiting"}</span>
									</div>
									{selectedSession.usage ? (
										<dl className="studio-usage-grid">
											<div>
												<dt>Tokens</dt>
												<dd>{formatCount(selectedSession.usage.totalTokens)}</dd>
											</div>
											<div>
												<dt>Tools</dt>
												<dd>{formatCount(selectedSession.usage.toolCalls)}</dd>
											</div>
											<div>
												<dt>Cost</dt>
												<dd>${formatCost(selectedSession.usage.cost)}</dd>
											</div>
										</dl>
									) : (
										<p className="studio-inspector-empty">Usage appears after the first response.</p>
									)}
								</section>
							)}

							{approvalControls && (
								<section className="studio-inspector-section" aria-live="polite">
									<div className="studio-inspector-heading">
										<h2>Approvals</h2>
										<span>{pendingApprovalCount} waiting</span>
									</div>
									{selectedApprovals.length === 0 ? (
										<p className="studio-inspector-empty">No tool decision is waiting.</p>
									) : (
										<div className="studio-approval-list">
											{selectedApprovals.map(approval => (
												<article
													className={`studio-approval-card studio-approval-card-${approval.status}`}
													key={approval.id}
												>
													<div>
														<strong>{approval.toolName}</strong>
														<span>{approval.status}</span>
													</div>
													{approval.reason && <p>{approval.reason}</p>}
													{approval.status === "pending" && (
														<div className="studio-approval-actions">
															<button
																disabled={approvalPendingId !== null || controlPendingId !== null}
																onClick={() => void resolveToolApproval(approval, "approve")}
																type="button"
															>
																Approve
															</button>
															<button
																className="studio-approval-reject"
																disabled={approvalPendingId !== null || controlPendingId !== null}
																onClick={() => void resolveToolApproval(approval, "reject")}
																type="button"
															>
																Reject
															</button>
														</div>
													)}
												</article>
											))}
										</div>
									)}
								</section>
							)}

							<section className="studio-inspector-section studio-activity-section">
								<div className="studio-inspector-heading">
									<h2>Activity</h2>
									<span>{selectedSessionEvents.length}</span>
								</div>
								{selectedSessionEvents.length === 0 ? (
									<p className="studio-inspector-empty">Run activity will appear here.</p>
								) : (
									<ol className="studio-agent-stream">
										{selectedSessionEvents.map(event => (
											<li key={event.sequence}>
												<time>{formatShortTime(event.emittedAtMs)}</time>
												<span>
													{event.toolName ? `${event.toolName}: ${event.summary}` : event.summary}
												</span>
											</li>
										))}
									</ol>
								)}
							</section>

							{subagentVisibility && selectedSubagents.length > 0 && (
								<section className="studio-inspector-section">
									<div className="studio-inspector-heading">
										<h2>Subagents</h2>
										<span>{selectedSubagents.length}</span>
									</div>
									<div className="studio-subagent-list">
										{selectedSubagents.map(subagent => (
											<div className="studio-subagent-row" key={subagent.id}>
												<strong>{subagent.agent}</strong>
												<span>{subagent.status}</span>
											</div>
										))}
									</div>
								</section>
							)}
						</>
					) : (
						<p className="studio-inspector-empty studio-inspector-start">
							Select or start a session to inspect its activity.
						</p>
					)}
				</aside>
			</div>

			{setupOpen && (
				<div
					className="studio-drawer-backdrop"
					onMouseDown={event => {
						if (event.target === event.currentTarget) setSetupOpen(false);
					}}
				>
					<aside
						aria-labelledby="studio-setup-heading"
						aria-modal="true"
						className="studio-setup-drawer"
						role="dialog"
					>
						<header className="studio-drawer-header">
							<div>
								<span className="studio-drawer-kicker">Local configuration</span>
								<h2 id="studio-setup-heading">Setup</h2>
							</div>
							<button aria-label="Close setup" onClick={() => setSetupOpen(false)} type="button">
								Close
							</button>
						</header>

						<section className="studio-drawer-section" aria-labelledby="studio-workspaces-heading">
							<div className="studio-drawer-section-heading">
								<div>
									<span>01</span>
									<h3 id="studio-workspaces-heading">Project folders</h3>
								</div>
								<span>{workspaces.length}</span>
							</div>
							<form className="studio-workspace-form" onSubmit={registerWorkspace}>
								<label>
									<span>Folder</span>
									<input
										ref={workspacePathRef}
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
									<span>Label</span>
									<input
										autoComplete="off"
										disabled={workspacePending}
										name="workspace-label"
										onChange={event => setWorkspaceLabel(event.target.value)}
										placeholder="My app"
										value={workspaceLabel}
									/>
								</label>
								<div className="studio-drawer-form-actions">
									{window.ompStudio && (
										<button
											disabled={workspacePending || workspacePickerPending}
											onClick={() => void selectWorkspace()}
											type="button"
										>
											{workspacePickerPending ? "Opening" : "Choose folder"}
										</button>
									)}
									<button disabled={workspacePending || workspacePickerPending} type="submit">
										{workspacePending ? "Saving" : "Add project"}
									</button>
								</div>
							</form>
							{workspaceError && <p className="studio-inline-error">{workspaceError}</p>}
							{workspaces.length > 0 && (
								<div className="studio-drawer-list">
									{workspaces.map(workspace => (
										<div className="studio-drawer-row" key={workspace.id}>
											<button
												className={
													workspace.id === sessionWorkspaceId
														? "studio-drawer-row-select studio-drawer-row-select-active"
														: "studio-drawer-row-select"
												}
												onClick={() => setSessionWorkspaceId(workspace.id)}
												type="button"
											>
												{workspace.label}
											</button>
											<button
												aria-label={`Remove ${workspace.label}`}
												disabled={workspacePending}
												onClick={() => void removeWorkspace(workspace.id)}
												type="button"
											>
												Remove
											</button>
										</div>
									))}
								</div>
							)}
						</section>

						<section className="studio-drawer-section" aria-labelledby="studio-providers-heading">
							<div className="studio-drawer-section-heading">
								<div>
									<span>02</span>
									<h3 id="studio-providers-heading">Provider</h3>
								</div>
								<span>{providers.filter(provider => provider.authState !== "unconfigured").length} ready</span>
							</div>
							{providerOnboarding ? (
								<>
									{providerError && <p className="studio-inline-error">{providerError}</p>}
									<div className="studio-provider-list">
										{providers.length === 0 ? (
											<p className="studio-drawer-empty">No OMP providers are available yet.</p>
										) : (
											providers.map(provider => (
												<article className="studio-provider-row" key={provider.id}>
													<div>
														<strong>{provider.name}</strong>
														<span
															className={`studio-provider-state studio-provider-state-${provider.authState}`}
														>
															{providerState(provider)}
														</span>
														<small>
															{provider.models.length === 0
																? "No model discovered yet"
																: `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`}
														</small>
													</div>
													{provider.canLogin && (
														<button
															disabled={providerPending !== null}
															onClick={() => void startProviderLogin(provider)}
															type="button"
														>
															{providerPending === provider.id
																? "Connecting"
																: provider.authState === "authenticated"
																	? "Reconnect"
																	: "Connect"}
														</button>
													)}
												</article>
											))
										)}
									</div>
									{authFlow && (
										<section className="studio-auth-flow" aria-live="polite">
											<div>
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
											{isActiveAuthFlow(authFlow) && (
												<div className="studio-auth-actions">
													{(authFlow.launchUrl ?? authFlow.authorizationUrl) && (
														<button
															disabled={authBrowserPending}
															onClick={() => void openProviderAuthorization()}
															type="button"
														>
															{authBrowserPending ? "Opening sign-in" : "Open sign-in"}
														</button>
													)}
													<button
														disabled={authCancelPending}
														onClick={() => void cancelProviderLogin()}
														type="button"
													>
														{authCancelPending ? "Cancelling" : "Cancel"}
													</button>
												</div>
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
														{authPending ? "Sending" : "Continue"}
													</button>
												</form>
											)}
										</section>
									)}
								</>
							) : (
								<p className="studio-drawer-empty">Provider setup is unavailable in this Studio process.</p>
							)}
						</section>

						<section className="studio-drawer-section" aria-labelledby="studio-new-session-heading">
							<div className="studio-drawer-section-heading">
								<div>
									<span>03</span>
									<h3 id="studio-new-session-heading">New session</h3>
								</div>
								<span>{rpcSupervisor ? "Ready" : "Unavailable"}</span>
							</div>
							{rpcSupervisor ? (
								<form className="studio-session-form" onSubmit={createSession}>
									<label>
										<span>Project</span>
										<select
											disabled={sessionPending || workspaces.length === 0}
											onChange={event => setSessionWorkspaceId(event.target.value)}
											value={sessionWorkspaceId}
										>
											<option value="">Choose a project</option>
											{workspaces.map(workspace => (
												<option key={workspace.id} value={workspace.id}>
													{workspace.label}
												</option>
											))}
										</select>
									</label>
									<label>
										<span>Provider</span>
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
										<span>Model</span>
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
										<span>Name</span>
										<input
											ref={sessionNameRef}
											autoComplete="off"
											disabled={sessionPending}
											onChange={event => setSessionName(event.target.value)}
											placeholder="Release planning"
											value={sessionName}
										/>
									</label>
									<div className="studio-drawer-form-actions">
										<button
											aria-describedby={sessionStartBlockedReason ? "studio-session-requirement" : undefined}
											disabled={sessionPending || connection === "offline"}
											type="submit"
										>
											{sessionStartLabel}
										</button>
									</div>
								</form>
							) : (
								<p className="studio-drawer-empty">Start Studio through OMP to enable local sessions.</p>
							)}
							{sessionStartBlockedReason && (
								<p className="studio-session-requirement" id="studio-session-requirement">
									{sessionStartBlockedReason}
								</p>
							)}
							{sessionError && <p className="studio-inline-error">{sessionError}</p>}
						</section>
					</aside>
				</div>
			)}

			{error && <p className="studio-app-error">{error}</p>}
		</div>
	);
}
