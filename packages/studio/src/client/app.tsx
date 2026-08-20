import { ChevronDown, FolderPlus } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	StudioActivityEntry,
	StudioActivityListResponse,
	StudioApproval,
	StudioApprovalListResponse,
	StudioApprovalResponse,
	StudioAuthCancelResponse,
	StudioAuthContinueResponse,
	StudioAuthProgress,
	StudioBootstrap,
	StudioChangeSet,
	StudioChangeSetResponse,
	StudioControlLeaseResponse,
	StudioEventEnvelope,
	StudioEventResyncRequired,
	StudioImageAttachment,
	StudioPlanSummary,
	StudioPlanSummaryResponse,
	StudioPromptResponse,
	StudioProvider,
	StudioProviderListResponse,
	StudioProviderLoginResponse,
	StudioRun,
	StudioRunHistoryResponse,
	StudioRunResponse,
	StudioSession,
	StudioSessionListResponse,
	StudioSessionMode,
	StudioSessionResponse,
	StudioSubagent,
	StudioSubagentListResponse,
	StudioThinkingLevel,
	StudioToolDisplay,
	StudioToolDisplayListResponse,
	StudioTranscriptMessage,
	StudioTranscriptResponse,
	StudioUsage,
	StudioUsageHistoryEntry,
	StudioUsageHistoryResponse,
	StudioWorkspace,
	StudioWorkspaceListResponse,
	StudioWorkspaceResponse,
} from "../protocol";
import { mergeStudioActivitySnapshot, upsertStudioActivityEntry } from "./activity-state";
import { mergeStudioAuthProgress } from "./auth-flow";
import type { StudioContextPanel } from "./context-panel";
import type { StudioComposerImageDraft } from "./conversation/composer";
import { StudioConversationPane } from "./conversation/conversation-pane";
import { mergeStudioRunHistorySnapshot, upsertStudioRunHistory } from "./history/run-history-state";
import { StudioSessionInspector } from "./inspector/session-inspector";
import { StudioSessionRail } from "./navigation/session-rail";
import { mergeStudioPlanSummary } from "./plan-state";
import { isActiveRun, isTerminalRunStatus, mergeStudioSessionSnapshot, reconcileStudioSession } from "./session-state";
import { type StudioConnectionState, StudioTitlebar } from "./shell/titlebar";
import { getStudioThinkingPicker, getStudioThinkingVariantModel } from "./thinking-variants";
import { mergeStudioToolDisplaySnapshot, upsertStudioToolDisplay } from "./tool-display-state";
import { mergeStudioTranscriptSnapshot, upsertStudioTranscriptMessage } from "./transcript-state";

type ConnectionState = StudioConnectionState;

const STUDIO_MUTATION_TIMEOUT_MS = 30_000;
/** Reuse an unexpired control lease instead of renewing it, leaving room for the prompt round trip. */
const STUDIO_CONTROL_LEASE_REUSE_MARGIN_MS = 5_000;
/**
 * Shared empty collections for unselected or not-yet-loaded sessions. Inline `?? []` fallbacks would
 * allocate a fresh array on every render and defeat the memoized panes during streaming.
 */
const EMPTY_ACTIVITY: StudioActivityEntry[] = [];
const EMPTY_APPROVALS: StudioApproval[] = [];
const EMPTY_RUN_HISTORY: StudioRun[] = [];
const EMPTY_SUBAGENTS: StudioSubagent[] = [];
const EMPTY_TOOL_DISPLAYS: StudioToolDisplay[] = [];
const EMPTY_TRANSCRIPT: StudioTranscriptMessage[] = [];
const EMPTY_USAGE_HISTORY: StudioUsageHistoryEntry[] = [];
const STUDIO_MAX_IMAGE_ATTACHMENTS = 4;
const STUDIO_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function isSupportedImageMimeType(value: string): value is StudioImageAttachment["mimeType"] {
	return value === "image/jpeg" || value === "image/png" || value === "image/webp" || value === "image/gif";
}

function imageTranscriptText(imageCount: number): string {
	return imageCount === 1 ? "Attached image" : `Attached ${imageCount} images`;
}

async function readImageAttachment(file: File): Promise<StudioImageAttachment> {
	const mimeType = file.type;
	if (!isSupportedImageMimeType(mimeType)) {
		throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
	}
	if (file.size > STUDIO_MAX_IMAGE_BYTES) {
		throw new Error("Each image must be 5 MB or smaller.");
	}
	const reader = new FileReader();
	const { promise, reject, resolve } = Promise.withResolvers<StudioImageAttachment>();
	reader.addEventListener("error", () => reject(new Error("Studio could not read that image.")), { once: true });
	reader.addEventListener(
		"load",
		() => {
			if (typeof reader.result !== "string") {
				reject(new Error("Studio could not read that image."));
				return;
			}
			const prefix = `data:${mimeType};base64,`;
			if (!reader.result.startsWith(prefix)) {
				reject(new Error("Studio could not encode that image."));
				return;
			}
			resolve({ type: "image", data: reader.result.slice(prefix.length), mimeType });
		},
		{ once: true },
	);
	reader.readAsDataURL(file);
	return await promise;
}

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

interface StudioResponseFailure {
	code?: string;
	message: string;
}

async function readResponseFailure(response: Response): Promise<StudioResponseFailure> {
	try {
		const body: unknown = await response.json();
		if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
			return {
				...(typeof body.error.code === "string" ? { code: body.error.code } : {}),
				message: body.error.message,
			};
		}
	} catch {
		// Use the stable HTTP fallback when a local response does not contain an API error body.
	}
	return { message: `Studio request failed with HTTP ${response.status}.` };
}

async function responseError(response: Response): Promise<string> {
	return (await readResponseFailure(response)).message;
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

function invalidateSessionRequestIds(requestIds: Map<string, number>): void {
	for (const [studioSessionId, requestId] of requestIds) requestIds.set(studioSessionId, requestId + 1);
}

function invalidateRemovedSessionRequestIds(
	requestIds: Map<string, number>,
	studioSessionIds: ReadonlySet<string>,
): void {
	for (const studioSessionId of studioSessionIds) {
		const requestId = requestIds.get(studioSessionId);
		if (requestId !== undefined) requestIds.set(studioSessionId, requestId + 1);
	}
}

function withoutStudioSessionEntries<T>(
	current: Record<string, T>,
	studioSessionIds: ReadonlySet<string>,
): Record<string, T> {
	const next = { ...current };
	for (const studioSessionId of studioSessionIds) delete next[studioSessionId];
	return next;
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

function isStudioActivityEntry(value: unknown): value is StudioActivityEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.studioSessionId === "string" &&
		typeof value.runId === "string" &&
		typeof value.occurredAtMs === "number" &&
		Number.isSafeInteger(value.occurredAtMs) &&
		value.occurredAtMs >= 0 &&
		typeof value.subject === "string" &&
		[
			"agent",
			"command",
			"file_read",
			"file_write",
			"file_search",
			"web",
			"task",
			"context",
			"retry",
			"tool",
			"system",
		].includes(value.subject) &&
		typeof value.status === "string" &&
		["running", "completed", "failed", "cancelled"].includes(value.status)
	);
}

function parseActivityUpdated(
	message: unknown,
): message is StudioEventEnvelope<StudioActivityEntry> & { runId: string; studioSessionId: string } {
	if (!isRecord(message)) return false;
	return (
		message.type === "activity.updated" &&
		typeof message.runId === "string" &&
		typeof message.studioSessionId === "string" &&
		isStudioActivityEntry(message.data) &&
		message.data.runId === message.runId &&
		message.data.studioSessionId === message.studioSessionId
	);
}

function isStudioToolDisplay(value: unknown): value is StudioToolDisplay {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.studioSessionId === "string" &&
		typeof value.runId === "string" &&
		typeof value.kind === "string" &&
		["command", "file_read", "file_write", "file_search", "web", "task", "tool"].includes(value.kind) &&
		typeof value.status === "string" &&
		["running", "completed", "failed", "cancelled"].includes(value.status) &&
		typeof value.startedAtMs === "number" &&
		Number.isSafeInteger(value.startedAtMs) &&
		value.startedAtMs >= 0 &&
		typeof value.updatedAtMs === "number" &&
		Number.isSafeInteger(value.updatedAtMs) &&
		value.updatedAtMs >= value.startedAtMs
	);
}

function parseToolDisplayUpdated(
	message: unknown,
): message is StudioEventEnvelope<StudioToolDisplay> & { runId: string; studioSessionId: string } {
	if (!isRecord(message)) return false;
	return (
		message.type === "tool.display_updated" &&
		typeof message.runId === "string" &&
		typeof message.studioSessionId === "string" &&
		isStudioToolDisplay(message.data) &&
		message.data.runId === message.runId &&
		message.data.studioSessionId === message.studioSessionId
	);
}

function isStudioPlanSummary(value: unknown): value is StudioPlanSummary {
	if (!isRecord(value)) return false;
	if (typeof value.studioSessionId !== "string" || typeof value.runId !== "string") return false;
	const countKeys = [
		"totalTaskCount",
		"pendingTaskCount",
		"inProgressTaskCount",
		"completedTaskCount",
		"blockedTaskCount",
		"abandonedTaskCount",
		"updatedAtMs",
	];
	return countKeys.every(key => {
		const count = value[key];
		return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
	});
}

function parsePlanUpdated(
	message: unknown,
): message is StudioEventEnvelope<StudioPlanSummary> & { runId: string; studioSessionId: string } {
	if (!isRecord(message)) return false;
	return (
		message.type === "plan.updated" &&
		typeof message.runId === "string" &&
		typeof message.studioSessionId === "string" &&
		isStudioPlanSummary(message.data) &&
		message.data.runId === message.runId &&
		message.data.studioSessionId === message.studioSessionId
	);
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
	const [workspaceRemovalPendingId, setWorkspaceRemovalPendingId] = useState<string | null>(null);
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
	const [sessionMode, setSessionMode] = useState<StudioSessionMode>("code");
	const [sessionPending, setSessionPending] = useState(false);
	const [sessionConnectPendingId, setSessionConnectPendingId] = useState<string | null>(null);
	const [sessionModePendingId, setSessionModePendingId] = useState<string | null>(null);
	const [sessionModelPendingId, setSessionModelPendingId] = useState<string | null>(null);
	const [sessionThinkingPendingId, setSessionThinkingPendingId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(loadStoredSessionId);
	const [contextPanel, setContextPanel] = useState<StudioContextPanel>("overview");
	const [contextOpen, setContextOpen] = useState(false);
	const [navigationOpen, setNavigationOpen] = useState(false);
	const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
	const [promptImagesBySession, setPromptImagesBySession] = useState<Record<string, StudioComposerImageDraft[]>>({});
	const [promptImagePending, setPromptImagePending] = useState(false);
	const [promptPending, setPromptPending] = useState(false);
	const [cancelPending, setCancelPending] = useState(false);
	const [transcriptBySession, setTranscriptBySession] = useState<Record<string, StudioTranscriptMessage[]>>({});
	const [transcriptErrorsBySession, setTranscriptErrorsBySession] = useState<Record<string, string>>({});
	const [transcriptLoadingBySession, setTranscriptLoadingBySession] = useState<Record<string, boolean>>({});
	/** Ordinal cursor for the oldest loaded message per session; absent once the head of history is loaded. */
	const [transcriptCursorBySession, setTranscriptCursorBySession] = useState<Record<string, number | undefined>>({});
	const [earlierTranscriptPendingId, setEarlierTranscriptPendingId] = useState<string | null>(null);
	const [activityBySession, setActivityBySession] = useState<Record<string, StudioActivityEntry[]>>({});
	const [activityErrorsBySession, setActivityErrorsBySession] = useState<Record<string, string>>({});
	const [activityLoadingBySession, setActivityLoadingBySession] = useState<Record<string, boolean>>({});
	const [toolDisplaysBySession, setToolDisplaysBySession] = useState<Record<string, StudioToolDisplay[]>>({});
	const [toolDisplayErrorsBySession, setToolDisplayErrorsBySession] = useState<Record<string, string>>({});
	const [toolDisplayLoadingBySession, setToolDisplayLoadingBySession] = useState<Record<string, boolean>>({});
	const [plansBySession, setPlansBySession] = useState<Record<string, StudioPlanSummary | undefined>>({});
	const [planErrorsBySession, setPlanErrorsBySession] = useState<Record<string, string>>({});
	const [planLoadingBySession, setPlanLoadingBySession] = useState<Record<string, boolean>>({});
	const [changeSetsBySession, setChangeSetsBySession] = useState<Record<string, StudioChangeSet | undefined>>({});
	const [changeSetErrorsBySession, setChangeSetErrorsBySession] = useState<Record<string, string>>({});
	const [changeSetLoadingBySession, setChangeSetLoadingBySession] = useState<Record<string, boolean>>({});
	const [runHistoryBySession, setRunHistoryBySession] = useState<Record<string, StudioRun[]>>({});
	const [runHistoryErrorsBySession, setRunHistoryErrorsBySession] = useState<Record<string, string>>({});
	const [runHistoryLoadingBySession, setRunHistoryLoadingBySession] = useState<Record<string, boolean>>({});
	const [usageHistoryBySession, setUsageHistoryBySession] = useState<Record<string, StudioUsageHistoryEntry[]>>({});
	const [usageHistoryErrorsBySession, setUsageHistoryErrorsBySession] = useState<Record<string, string>>({});
	const [usageHistoryLoadingBySession, setUsageHistoryLoadingBySession] = useState<Record<string, boolean>>({});
	const setupAutoOpenedRef = useRef(false);
	const [setupOpen, setSetupOpen] = useState(() => {
		const shouldOpen = loadStoredSessionId() === null;
		setupAutoOpenedRef.current = shouldOpen;
		return shouldOpen;
	});
	const [projectManagerOpen, setProjectManagerOpen] = useState(false);
	const [providerManagerOpen, setProviderManagerOpen] = useState(false);
	const [controlPendingId, setControlPendingId] = useState<string | null>(null);
	const [leaseExpiresAtMs, setLeaseExpiresAtMs] = useState<Record<string, number>>({});
	const [approvalPendingId, setApprovalPendingId] = useState<string | null>(null);
	const [approvalsBySession, setApprovalsBySession] = useState<Record<string, StudioApproval[]>>({});
	const [subagentsBySession, setSubagentsBySession] = useState<Record<string, StudioSubagent[]>>({});
	const [resyncRevision, setResyncRevision] = useState(0);
	const lastEventSequenceRef = useRef(0);
	const autoOpenedAuthFlowIdsRef = useRef(new Set<string>());
	const conversationScrollRef = useRef<HTMLElement>(null);
	const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
	const workspacePathRef = useRef<HTMLInputElement>(null);
	const sessionWorkspaceRef = useRef<HTMLSelectElement>(null);
	const sessionNameRef = useRef<HTMLInputElement>(null);
	const notifiedRunIdsRef = useRef(new Set<string>());
	const runStateBySessionRef = useRef(new Map<string, StudioRun>());
	const sessionSnapshotVersionRef = useRef(0);
	const sessionListRequestIdRef = useRef(0);
	const transcriptRequestIdsRef = useRef(new Map<string, number>());
	const earlierTranscriptPendingIdsRef = useRef(new Set<string>());
	const controlPendingIdRef = useRef<string | null>(null);
	const activityRequestIdsRef = useRef(new Map<string, number>());
	const toolDisplayRequestIdsRef = useRef(new Map<string, number>());
	const planRequestIdsRef = useRef(new Map<string, number>());
	const changeSetRequestIdsRef = useRef(new Map<string, number>());
	const runHistoryRequestIdsRef = useRef(new Map<string, number>());
	const usageHistoryRequestIdsRef = useRef(new Map<string, number>());
	const connectionAttemptedSessionIdsRef = useRef(new Set<string>());
	const connectedSessionIdsRef = useRef(new Set<string>());
	const connectionPromisesRef = useRef(new Map<string, Promise<boolean>>());
	const conversationScrollFrameRef = useRef<number | undefined>(undefined);
	const shouldAutoScrollConversationRef = useRef(true);
	const openSetup = useCallback((): void => {
		setupAutoOpenedRef.current = false;
		setSetupOpen(true);
	}, []);
	const openNavigation = useCallback((): void => {
		setContextOpen(false);
		setNavigationOpen(true);
	}, []);
	const openContext = useCallback((panel: StudioContextPanel): void => {
		setContextPanel(panel);
		setNavigationOpen(false);
		setContextOpen(true);
	}, []);
	const closeContext = useCallback((): void => {
		setContextOpen(false);
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
		const requestId = sessionListRequestIdRef.current + 1;
		sessionListRequestIdRef.current = requestId;
		const snapshotVersion = sessionSnapshotVersionRef.current;
		setSessionError(null);
		try {
			const response = await fetch("/api/v1/sessions");
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioSessionListResponse;
			if (sessionListRequestIdRef.current !== requestId) return;
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
			if (sessionListRequestIdRef.current === requestId) {
				setSessionError(reason instanceof Error ? reason.message : "Studio could not load local sessions.");
			}
		}
	}, []);

	const connectSession = useCallback(async (studioSessionId: string, retry = false): Promise<boolean> => {
		if (!retry && connectedSessionIdsRef.current.has(studioSessionId)) return true;
		const existing = connectionPromisesRef.current.get(studioSessionId);
		if (existing) return await existing;
		if (!retry && connectionAttemptedSessionIdsRef.current.has(studioSessionId)) return false;
		connectionAttemptedSessionIdsRef.current.add(studioSessionId);
		const connection = (async (): Promise<boolean> => {
			setSessionConnectPendingId(studioSessionId);
			setSessionError(null);
			const startingAtMs = Date.now();
			setSessions(current =>
				sortSessions(
					current.map(session =>
						session.id === studioSessionId
							? { ...session, status: "starting", updatedAtMs: startingAtMs }
							: session,
					),
				),
			);
			try {
				const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/connect`, {
					method: "POST",
					signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(await responseError(response));
				const body = (await response.json()) as StudioSessionResponse;
				connectedSessionIdsRef.current.add(studioSessionId);
				sessionSnapshotVersionRef.current += 1;
				setSessions(current =>
					sortSessions(current.map(session => (session.id === studioSessionId ? body.session : session))),
				);
				return true;
			} catch (reason) {
				// A prompt can start this session through the same supervisor while this background warm-up
				// request is still in flight. In that case the late connection failure is no longer relevant.
				if (connectedSessionIdsRef.current.has(studioSessionId)) return true;
				connectedSessionIdsRef.current.delete(studioSessionId);
				const failedAtMs = Date.now();
				setSessions(current =>
					sortSessions(
						current.map(session =>
							session.id === studioSessionId && session.status === "starting"
								? { ...session, status: "failed", updatedAtMs: failedAtMs }
								: session,
						),
					),
				);
				setSessionError(
					reason instanceof Error ? reason.message : "Studio could not connect this session to OMP. Try again.",
				);
				return false;
			} finally {
				setSessionConnectPendingId(current => (current === studioSessionId ? null : current));
			}
		})();
		connectionPromisesRef.current.set(studioSessionId, connection);
		try {
			return await connection;
		} finally {
			connectionPromisesRef.current.delete(studioSessionId);
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
				setTranscriptCursorBySession(current => ({ ...current, [studioSessionId]: undefined }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioTranscriptResponse;
			if (transcriptRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setTranscriptBySession(current => ({
				...current,
				[studioSessionId]: mergeStudioTranscriptSnapshot(current[studioSessionId] ?? [], body.messages),
			}));
			setTranscriptCursorBySession(current => ({ ...current, [studioSessionId]: body.nextBeforeOrdinal }));
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

	/**
	 * Prepends the page immediately older than the loaded head of a conversation. The transcript
	 * generation is read without being bumped so a concurrent full reload always wins, and the
	 * paging state is tracked separately from `transcriptLoading` to keep the composer usable.
	 */
	const loadEarlierTranscript = useCallback(async (studioSessionId: string, beforeOrdinal: number): Promise<void> => {
		if (earlierTranscriptPendingIdsRef.current.has(studioSessionId)) return;
		earlierTranscriptPendingIdsRef.current.add(studioSessionId);
		const requestId = transcriptRequestIdsRef.current.get(studioSessionId) ?? 0;
		setEarlierTranscriptPendingId(studioSessionId);
		setTranscriptErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		try {
			const query = new URLSearchParams({ before: String(beforeOrdinal) });
			const response = await fetch(
				`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/transcript?${query.toString()}`,
			);
			if (transcriptRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioTranscriptResponse;
			if (transcriptRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			shouldAutoScrollConversationRef.current = false;
			setTranscriptBySession(current => ({
				...current,
				[studioSessionId]: mergeStudioTranscriptSnapshot(current[studioSessionId] ?? [], body.messages),
			}));
			setTranscriptCursorBySession(current => ({ ...current, [studioSessionId]: body.nextBeforeOrdinal }));
		} catch (reason) {
			if (transcriptRequestIdsRef.current.get(studioSessionId) === requestId) {
				setTranscriptErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load earlier messages.",
				}));
			}
		} finally {
			earlierTranscriptPendingIdsRef.current.delete(studioSessionId);
			setEarlierTranscriptPendingId(current => (current === studioSessionId ? null : current));
		}
	}, []);

	const loadActivity = useCallback(async (studioSessionId: string): Promise<void> => {
		const requestId = (activityRequestIdsRef.current.get(studioSessionId) ?? 0) + 1;
		activityRequestIdsRef.current.set(studioSessionId, requestId);
		setActivityErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		setActivityLoadingBySession(current => ({ ...current, [studioSessionId]: true }));
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/activity`);
			if (activityRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (response.status === 404) {
				setActivityBySession(current => ({ ...current, [studioSessionId]: current[studioSessionId] ?? [] }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioActivityListResponse;
			if (activityRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setActivityBySession(current => ({
				...current,
				[studioSessionId]: mergeStudioActivitySnapshot(current[studioSessionId] ?? [], body.entries),
			}));
		} catch (reason) {
			if (activityRequestIdsRef.current.get(studioSessionId) === requestId) {
				setActivityErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load run activity.",
				}));
			}
		} finally {
			if (activityRequestIdsRef.current.get(studioSessionId) === requestId) {
				setActivityLoadingBySession(current => ({ ...current, [studioSessionId]: false }));
			}
		}
	}, []);

	const loadToolDisplays = useCallback(async (studioSessionId: string): Promise<void> => {
		const requestId = (toolDisplayRequestIdsRef.current.get(studioSessionId) ?? 0) + 1;
		toolDisplayRequestIdsRef.current.set(studioSessionId, requestId);
		setToolDisplayErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		setToolDisplayLoadingBySession(current => ({ ...current, [studioSessionId]: true }));
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/tools`);
			if (toolDisplayRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (response.status === 404) {
				setToolDisplaysBySession(current => ({ ...current, [studioSessionId]: current[studioSessionId] ?? [] }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioToolDisplayListResponse;
			if (toolDisplayRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setToolDisplaysBySession(current => ({
				...current,
				[studioSessionId]: mergeStudioToolDisplaySnapshot(current[studioSessionId] ?? [], body.cards),
			}));
		} catch (reason) {
			if (toolDisplayRequestIdsRef.current.get(studioSessionId) === requestId) {
				setToolDisplayErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load tool cards.",
				}));
			}
		} finally {
			if (toolDisplayRequestIdsRef.current.get(studioSessionId) === requestId) {
				setToolDisplayLoadingBySession(current => ({ ...current, [studioSessionId]: false }));
			}
		}
	}, []);

	const loadPlanSummary = useCallback(async (studioSessionId: string): Promise<void> => {
		const requestId = (planRequestIdsRef.current.get(studioSessionId) ?? 0) + 1;
		planRequestIdsRef.current.set(studioSessionId, requestId);
		setPlanErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		setPlanLoadingBySession(current => ({ ...current, [studioSessionId]: true }));
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/plan`);
			if (planRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (response.status === 404) {
				setPlansBySession(current => ({ ...current, [studioSessionId]: current[studioSessionId] }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioPlanSummaryResponse;
			if (planRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setPlansBySession(current => ({
				...current,
				[studioSessionId]: mergeStudioPlanSummary(current[studioSessionId], body.plan),
			}));
		} catch (reason) {
			if (planRequestIdsRef.current.get(studioSessionId) === requestId) {
				setPlanErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load plan progress.",
				}));
			}
		} finally {
			if (planRequestIdsRef.current.get(studioSessionId) === requestId) {
				setPlanLoadingBySession(current => ({ ...current, [studioSessionId]: false }));
			}
		}
	}, []);

	const loadChangeSet = useCallback(async (studioSessionId: string): Promise<void> => {
		const requestId = (changeSetRequestIdsRef.current.get(studioSessionId) ?? 0) + 1;
		changeSetRequestIdsRef.current.set(studioSessionId, requestId);
		setChangeSetErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		setChangeSetLoadingBySession(current => ({ ...current, [studioSessionId]: true }));
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/changes`);
			if (changeSetRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (response.status === 404) {
				setChangeSetsBySession(current => ({ ...current, [studioSessionId]: current[studioSessionId] }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioChangeSetResponse;
			if (changeSetRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setChangeSetsBySession(current => ({ ...current, [studioSessionId]: body.changeSet }));
		} catch (reason) {
			if (changeSetRequestIdsRef.current.get(studioSessionId) === requestId) {
				setChangeSetErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load project changes.",
				}));
			}
		} finally {
			if (changeSetRequestIdsRef.current.get(studioSessionId) === requestId) {
				setChangeSetLoadingBySession(current => ({ ...current, [studioSessionId]: false }));
			}
		}
	}, []);

	const loadRunHistory = useCallback(async (studioSessionId: string): Promise<void> => {
		const requestId = (runHistoryRequestIdsRef.current.get(studioSessionId) ?? 0) + 1;
		runHistoryRequestIdsRef.current.set(studioSessionId, requestId);
		setRunHistoryErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		setRunHistoryLoadingBySession(current => ({ ...current, [studioSessionId]: true }));
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/runs`);
			if (runHistoryRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (response.status === 404) {
				setRunHistoryBySession(current => ({ ...current, [studioSessionId]: current[studioSessionId] ?? [] }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioRunHistoryResponse;
			if (runHistoryRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setRunHistoryBySession(current => ({
				...current,
				[studioSessionId]: mergeStudioRunHistorySnapshot(current[studioSessionId] ?? [], body.runs),
			}));
		} catch (reason) {
			if (runHistoryRequestIdsRef.current.get(studioSessionId) === requestId) {
				setRunHistoryErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load run history.",
				}));
			}
		} finally {
			if (runHistoryRequestIdsRef.current.get(studioSessionId) === requestId) {
				setRunHistoryLoadingBySession(current => ({ ...current, [studioSessionId]: false }));
			}
		}
	}, []);

	const loadUsageHistory = useCallback(async (studioSessionId: string): Promise<void> => {
		const requestId = (usageHistoryRequestIdsRef.current.get(studioSessionId) ?? 0) + 1;
		usageHistoryRequestIdsRef.current.set(studioSessionId, requestId);
		setUsageHistoryErrorsBySession(current => {
			const next = { ...current };
			delete next[studioSessionId];
			return next;
		});
		setUsageHistoryLoadingBySession(current => ({ ...current, [studioSessionId]: true }));
		try {
			const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/usage-history`);
			if (usageHistoryRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			if (response.status === 404) {
				setUsageHistoryBySession(current => ({ ...current, [studioSessionId]: current[studioSessionId] ?? [] }));
				return;
			}
			if (!response.ok) throw new Error(await responseError(response));
			const body = (await response.json()) as StudioUsageHistoryResponse;
			if (usageHistoryRequestIdsRef.current.get(studioSessionId) !== requestId) return;
			setUsageHistoryBySession(current => ({ ...current, [studioSessionId]: body.entries }));
		} catch (reason) {
			if (usageHistoryRequestIdsRef.current.get(studioSessionId) === requestId) {
				setUsageHistoryErrorsBySession(current => ({
					...current,
					[studioSessionId]: reason instanceof Error ? reason.message : "Studio could not load usage history.",
				}));
			}
		} finally {
			if (usageHistoryRequestIdsRef.current.get(studioSessionId) === requestId) {
				setUsageHistoryLoadingBySession(current => ({ ...current, [studioSessionId]: false }));
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
		const recentWorkspaceId = sortSessions(sessions).find(
			session => session.workspaceId && workspaces.some(workspace => workspace.id === session.workspaceId),
		)?.workspaceId;
		setSessionWorkspaceId(recentWorkspaceId ?? workspaces[0]?.id ?? "");
	}, [sessionWorkspaceId, sessions, workspaces]);

	useEffect(() => {
		const preferredSession = sortSessions(sessions).find(session => {
			if (!session.model) return false;
			const provider = providers.find(candidate => candidate.id === session.model?.provider);
			return provider?.models.some(model => model.id === session.model?.id) === true;
		});
		const provider =
			providers.find(candidate => candidate.id === sessionProviderId && candidate.models.length > 0) ??
			providers.find(
				candidate => candidate.id === preferredSession?.model?.provider && candidate.models.length > 0,
			) ??
			providers.find(candidate => candidate.models.length > 0);
		if (!provider) {
			setSessionProviderId("");
			setSessionModelId("");
			return;
		}
		if (provider.id !== sessionProviderId) setSessionProviderId(provider.id);
		const preferredModelId =
			preferredSession?.model?.provider === provider.id ? preferredSession.model.id : undefined;
		const model =
			provider.models.find(candidate => candidate.id === sessionModelId) ??
			provider.models.find(candidate => candidate.id === preferredModelId) ??
			provider.models[0];
		if (model && model.id !== sessionModelId) setSessionModelId(model.id);
	}, [providers, sessions, sessionModelId, sessionProviderId]);

	useEffect(() => {
		if (selectedSessionId && sessions.some(session => session.id === selectedSessionId)) return;
		setSelectedSessionId(sessions[0]?.id ?? null);
	}, [selectedSessionId, sessions]);

	// Tracked as a primitive so the connect effect below does not re-run on every unrelated session-list
	// update (status flips, activity timestamps) while a spawn is still in flight.
	const selectedSessionKnown = sessions.some(session => session.id === selectedSessionId);

	useEffect(() => {
		if (!bootstrap?.features.rpcSupervisor || !selectedSessionId || !selectedSessionKnown) return;
		void connectSession(selectedSessionId);
	}, [bootstrap?.features.rpcSupervisor, connectSession, selectedSessionId, selectedSessionKnown]);

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
		if (!selectedSessionId || !bootstrap?.features.activityTimeline) return;
		void loadActivity(selectedSessionId);
	}, [bootstrap?.features.activityTimeline, loadActivity, resyncRevision, selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.toolCards) return;
		void loadToolDisplays(selectedSessionId);
	}, [bootstrap?.features.toolCards, loadToolDisplays, resyncRevision, selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.planSummary) return;
		void loadPlanSummary(selectedSessionId);
	}, [bootstrap?.features.planSummary, loadPlanSummary, resyncRevision, selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.changeReview) return;
		void loadChangeSet(selectedSessionId);
	}, [bootstrap?.features.changeReview, loadChangeSet, resyncRevision, selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.runHistory) return;
		void loadRunHistory(selectedSessionId);
	}, [bootstrap?.features.runHistory, loadRunHistory, resyncRevision, selectedSessionId]);

	useEffect(() => {
		if (!selectedSessionId || !bootstrap?.features.usageHistory) return;
		void loadUsageHistory(selectedSessionId);
	}, [bootstrap?.features.usageHistory, loadUsageHistory, resyncRevision, selectedSessionId]);

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
						setActivityBySession({});
						setActivityErrorsBySession({});
						setActivityLoadingBySession({});
						setToolDisplaysBySession({});
						setToolDisplayErrorsBySession({});
						setToolDisplayLoadingBySession({});
						setPlansBySession({});
						setPlanErrorsBySession({});
						setPlanLoadingBySession({});
						setChangeSetsBySession({});
						setChangeSetErrorsBySession({});
						setChangeSetLoadingBySession({});
						setRunHistoryBySession({});
						setRunHistoryErrorsBySession({});
						setRunHistoryLoadingBySession({});
						setUsageHistoryBySession({});
						setUsageHistoryErrorsBySession({});
						setUsageHistoryLoadingBySession({});
						setApprovalsBySession({});
						setSubagentsBySession({});
						setTranscriptBySession({});
						setTranscriptErrorsBySession({});
						setTranscriptLoadingBySession({});
						setTranscriptCursorBySession({});
						sessionListRequestIdRef.current += 1;
						invalidateSessionRequestIds(transcriptRequestIdsRef.current);
						invalidateSessionRequestIds(activityRequestIdsRef.current);
						invalidateSessionRequestIds(toolDisplayRequestIdsRef.current);
						invalidateSessionRequestIds(planRequestIdsRef.current);
						invalidateSessionRequestIds(changeSetRequestIdsRef.current);
						invalidateSessionRequestIds(runHistoryRequestIdsRef.current);
						invalidateSessionRequestIds(usageHistoryRequestIdsRef.current);
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
						if (run.status === "interrupted") connectedSessionIdsRef.current.delete(message.studioSessionId);
						sessionSnapshotVersionRef.current += 1;
						setRunHistoryBySession(current => ({
							...current,
							[message.studioSessionId]: upsertStudioRunHistory(current[message.studioSessionId] ?? [], run),
						}));
						if (isTerminalRunStatus(run.status) && !notifiedRunIdsRef.current.has(run.id)) {
							notifiedRunIdsRef.current.add(run.id);
							const title = run.status === "failed" ? "OMP run needs attention" : "OMP run finished";
							const body =
								run.status === "failed"
									? "Open Studio to review the run state."
									: "Your session is ready for the next prompt.";
							void window.ompStudio?.notify(title, body).catch(() => undefined);
						}
						if (isTerminalRunStatus(run.status)) {
							void loadRunHistory(message.studioSessionId);
							void loadUsageHistory(message.studioSessionId);
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
						void loadUsageHistory(message.studioSessionId);
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
					if (parseActivityUpdated(message)) {
						setActivityBySession(current => ({
							...current,
							[message.studioSessionId]: upsertStudioActivityEntry(
								current[message.studioSessionId] ?? [],
								message.data,
							),
						}));
						return;
					}
					if (parseToolDisplayUpdated(message)) {
						setToolDisplaysBySession(current => ({
							...current,
							[message.studioSessionId]: upsertStudioToolDisplay(
								current[message.studioSessionId] ?? [],
								message.data,
							),
						}));
						return;
					}
					if (parsePlanUpdated(message)) {
						setPlansBySession(current => ({
							...current,
							[message.studioSessionId]: mergeStudioPlanSummary(current[message.studioSessionId], message.data),
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
	}, [loadProviders, loadRunHistory, loadUsageHistory]);

	const profile = bootstrap?.profile ?? "loading";
	const providerOnboarding = bootstrap?.features.providerOnboarding === true;
	const rpcSupervisor = bootstrap?.features.rpcSupervisor === true;
	const approvalControls = bootstrap?.features.approvalControls === true;
	const subagentVisibility = bootstrap?.features.subagentVisibility === true;
	const usageSummary = bootstrap?.features.usageSummary === true;
	const activityTimeline = bootstrap?.features.activityTimeline === true;
	const toolCards = bootstrap?.features.toolCards === true;
	const planSummary = bootstrap?.features.planSummary === true;
	const changeReview = bootstrap?.features.changeReview === true;
	const runHistory = bootstrap?.features.runHistory === true;
	const usageHistory = bootstrap?.features.usageHistory === true;
	const selectedSession = useMemo(
		() => sessions.find(session => session.id === selectedSessionId) ?? null,
		[sessions, selectedSessionId],
	);
	const selectedProvider = useMemo(
		() => providers.find(provider => provider.id === sessionProviderId) ?? null,
		[providers, sessionProviderId],
	);
	const selectedProviderModels = selectedProvider?.models ?? [];
	const quickStartWorkspaces = useMemo(() => {
		const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]));
		const orderedIds: string[] = [];
		const addWorkspaceId = (workspaceId: string | undefined): void => {
			if (!workspaceId || orderedIds.includes(workspaceId) || !workspaceById.has(workspaceId)) return;
			orderedIds.push(workspaceId);
		};
		addWorkspaceId(sessionWorkspaceId);
		for (const session of sortSessions(sessions)) addWorkspaceId(session.workspaceId);
		for (const workspace of workspaces) addWorkspaceId(workspace.id);
		return orderedIds.slice(0, 4).map(workspaceId => workspaceById.get(workspaceId) as StudioWorkspace);
	}, [sessionWorkspaceId, sessions, workspaces]);
	const sessionStartBlockedReason =
		connection === "offline"
			? "Studio is reconnecting."
			: !sessionWorkspaceId
				? "Register a workspace to start a session."
				: !sessionProviderId || !sessionModelId
					? "Connect a provider with an available model to start a session."
					: null;
	const sessionStartLabel = sessionPending
		? "Opening session"
		: !sessionWorkspaceId
			? "Choose a project"
			: !sessionProviderId || !sessionModelId
				? "Connect a provider"
				: "Start session";
	const selectedActivity = (selectedSessionId ? activityBySession[selectedSessionId] : undefined) ?? EMPTY_ACTIVITY;
	const selectedTranscript =
		(selectedSessionId ? transcriptBySession[selectedSessionId] : undefined) ?? EMPTY_TRANSCRIPT;
	const promptText = selectedSessionId ? (promptDrafts[selectedSessionId] ?? "") : "";
	const promptImages = selectedSessionId ? (promptImagesBySession[selectedSessionId] ?? []) : [];
	const transcriptError = selectedSessionId ? (transcriptErrorsBySession[selectedSessionId] ?? null) : null;
	const transcriptLoading = selectedSessionId ? transcriptLoadingBySession[selectedSessionId] === true : false;
	const earlierTranscriptOrdinal = selectedSessionId ? transcriptCursorBySession[selectedSessionId] : undefined;
	const earlierTranscriptPending = selectedSessionId !== null && earlierTranscriptPendingId === selectedSessionId;
	const activityError = selectedSessionId ? (activityErrorsBySession[selectedSessionId] ?? null) : null;
	const activityLoading = selectedSessionId ? activityLoadingBySession[selectedSessionId] === true : false;
	const selectedToolDisplays =
		(selectedSessionId ? toolDisplaysBySession[selectedSessionId] : undefined) ?? EMPTY_TOOL_DISPLAYS;
	const toolDisplayError = selectedSessionId ? (toolDisplayErrorsBySession[selectedSessionId] ?? null) : null;
	const toolDisplayLoading = selectedSessionId ? toolDisplayLoadingBySession[selectedSessionId] === true : false;
	const selectedPlan = selectedSessionId ? plansBySession[selectedSessionId] : undefined;
	const planError = selectedSessionId ? (planErrorsBySession[selectedSessionId] ?? null) : null;
	const planLoading = selectedSessionId ? planLoadingBySession[selectedSessionId] === true : false;
	const selectedChangeSet = selectedSessionId ? changeSetsBySession[selectedSessionId] : undefined;
	const changeSetError = selectedSessionId ? (changeSetErrorsBySession[selectedSessionId] ?? null) : null;
	const changeSetLoading = selectedSessionId ? changeSetLoadingBySession[selectedSessionId] === true : false;
	const selectedRunHistory =
		(selectedSessionId ? runHistoryBySession[selectedSessionId] : undefined) ?? EMPTY_RUN_HISTORY;
	const runHistoryError = selectedSessionId ? (runHistoryErrorsBySession[selectedSessionId] ?? null) : null;
	const runHistoryLoading = selectedSessionId ? runHistoryLoadingBySession[selectedSessionId] === true : false;
	const selectedUsageHistory =
		(selectedSessionId ? usageHistoryBySession[selectedSessionId] : undefined) ?? EMPTY_USAGE_HISTORY;
	const usageHistoryError = selectedSessionId ? (usageHistoryErrorsBySession[selectedSessionId] ?? null) : null;
	const usageHistoryLoading = selectedSessionId ? usageHistoryLoadingBySession[selectedSessionId] === true : false;
	const { displayedTranscript, hasStreamingAssistant } = useMemo(() => {
		let hasStreamingAssistant = false;
		const displayedTranscript = selectedTranscript.filter(message => {
			if (message.role === "assistant" && message.status === "streaming") hasStreamingAssistant = true;
			return message.role === "user" || message.text.length > 0 || message.status !== "streaming";
		});
		return { displayedTranscript, hasStreamingAssistant };
	}, [selectedTranscript]);
	const selectedApprovals = (selectedSessionId ? approvalsBySession[selectedSessionId] : undefined) ?? EMPTY_APPROVALS;
	const selectedSubagents = (selectedSessionId ? subagentsBySession[selectedSessionId] : undefined) ?? EMPTY_SUBAGENTS;
	const selectedActiveRun = isActiveRun(selectedSession?.activeRun) ? selectedSession.activeRun : undefined;
	const selectedSessionModel = useMemo(() => {
		if (!selectedSession?.model) return null;
		const provider = providers.find(candidate => candidate.id === selectedSession.model?.provider);
		return provider?.models.find(candidate => candidate.id === selectedSession.model?.id) ?? null;
	}, [providers, selectedSession?.model]);
	const selectedSessionProviderModels = useMemo(
		() => providers.find(provider => provider.id === selectedSession?.model?.provider)?.models ?? [],
		[providers, selectedSession?.model?.provider],
	);
	const selectedSessionSupportsImageInput = selectedSessionModel?.supportsImageInput === true;
	const selectedSessionThinkingPicker = useMemo(
		() => getStudioThinkingPicker(selectedSessionModel ?? undefined, selectedSessionProviderModels),
		[selectedSessionModel, selectedSessionProviderModels],
	);
	const selectedSessionThinkingLevels = selectedSessionThinkingPicker?.levels;
	const selectedSessionThinkingLevel =
		selectedSessionThinkingPicker?.kind === "model_variant"
			? selectedSessionThinkingPicker.selectedLevel
			: selectedSession?.model?.thinkingLevel;
	const selectedWorkspace = useMemo(
		() => workspaces.find(workspace => workspace.id === selectedSession?.workspaceId) ?? null,
		[selectedSession?.workspaceId, workspaces],
	);
	const selectedSessionConnecting =
		selectedSession !== null &&
		(sessionConnectPendingId === selectedSession.id || selectedSession.status === "starting");
	/**
	 * A cold RPC spawn takes a couple of seconds, so the composer deliberately stays live while a
	 * session connects: `submitPrompt` awaits the in-flight connect and sends as soon as it lands.
	 */
	const composerBlocked =
		promptPending || cancelPending || controlPendingId !== null || selectedActiveRun !== undefined;

	const registerWorkspacePath = useCallback(
		async (path: string): Promise<void> => {
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
		},
		[workspaceLabel, workspacePending],
	);

	const registerWorkspace = useCallback(
		async (event: FormEvent<HTMLFormElement>): Promise<void> => {
			event.preventDefault();
			await registerWorkspacePath(workspacePath.trim());
		},
		[registerWorkspacePath, workspacePath],
	);

	const selectWorkspace = useCallback(async (): Promise<void> => {
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
	}, [registerWorkspacePath, workspacePending, workspacePickerPending]);

	const removeWorkspace = async (workspaceId: string): Promise<void> => {
		if (workspacePending) return;
		const workspace = workspaces.find(current => current.id === workspaceId);
		if (
			!window.confirm(
				`Remove ${workspace?.label ?? "this project"} from Studio? Its local Studio sessions and history will be removed, but project files will stay on disk.`,
			)
		) {
			return;
		}
		setWorkspaceError(null);
		setWorkspacePending(true);
		setWorkspaceRemovalPendingId(workspaceId);
		try {
			const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
				method: "DELETE",
				signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(await responseError(response));
			const removedSessionIds = new Set(
				sessions.filter(session => session.workspaceId === workspaceId).map(session => session.id),
			);
			const remainingSessions = sessions.filter(session => !removedSessionIds.has(session.id));
			const remainingWorkspaceId = workspaces.find(current => current.id !== workspaceId)?.id ?? "";
			sessionSnapshotVersionRef.current += 1;
			sessionListRequestIdRef.current += 1;
			invalidateRemovedSessionRequestIds(transcriptRequestIdsRef.current, removedSessionIds);
			invalidateRemovedSessionRequestIds(activityRequestIdsRef.current, removedSessionIds);
			invalidateRemovedSessionRequestIds(toolDisplayRequestIdsRef.current, removedSessionIds);
			invalidateRemovedSessionRequestIds(planRequestIdsRef.current, removedSessionIds);
			invalidateRemovedSessionRequestIds(changeSetRequestIdsRef.current, removedSessionIds);
			invalidateRemovedSessionRequestIds(runHistoryRequestIdsRef.current, removedSessionIds);
			invalidateRemovedSessionRequestIds(usageHistoryRequestIdsRef.current, removedSessionIds);
			for (const studioSessionId of removedSessionIds) {
				connectionAttemptedSessionIdsRef.current.delete(studioSessionId);
				connectedSessionIdsRef.current.delete(studioSessionId);
				connectionPromisesRef.current.delete(studioSessionId);
				runStateBySessionRef.current.delete(studioSessionId);
			}
			setWorkspaces(current => current.filter(workspace => workspace.id !== workspaceId));
			setSessions(current => current.filter(session => !removedSessionIds.has(session.id)));
			setPromptDrafts(current => withoutStudioSessionEntries(current, removedSessionIds));
			setTranscriptBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setTranscriptErrorsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setTranscriptLoadingBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setTranscriptCursorBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setActivityBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setActivityErrorsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setActivityLoadingBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setToolDisplaysBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setToolDisplayErrorsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setToolDisplayLoadingBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setPlansBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setPlanErrorsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setPlanLoadingBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setChangeSetsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setChangeSetErrorsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setChangeSetLoadingBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setRunHistoryBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setRunHistoryErrorsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setRunHistoryLoadingBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setUsageHistoryBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setUsageHistoryErrorsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setUsageHistoryLoadingBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setApprovalsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setSubagentsBySession(current => withoutStudioSessionEntries(current, removedSessionIds));
			setLeaseExpiresAtMs(current => withoutStudioSessionEntries(current, removedSessionIds));
			if (selectedSessionId && removedSessionIds.has(selectedSessionId)) {
				setSelectedSessionId(remainingSessions[0]?.id ?? null);
			}
			if (sessionWorkspaceId === workspaceId) setSessionWorkspaceId(remainingWorkspaceId);
		} catch (reason) {
			setWorkspaceError(reason instanceof Error ? reason.message : "Studio could not remove the workspace.");
		} finally {
			setWorkspacePending(false);
			setWorkspaceRemovalPendingId(null);
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

	const acquireControl = useCallback(
		async (studioSessionId: string, selectSession = true): Promise<boolean> => {
			// Guarded by a ref rather than the pending state: state updates are async, so two calls in the
			// same tick would both pass a state check, and reading state here would also churn this callback.
			if (controlPendingIdRef.current !== null) return false;
			controlPendingIdRef.current = studioSessionId;
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
				controlPendingIdRef.current = null;
				setControlPendingId(null);
			}
		},
		[holderId],
	);

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
					mode: sessionMode,
					provider: sessionProviderId,
					workspaceId: sessionWorkspaceId,
					...(name ? { name } : {}),
				}),
				signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
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
			window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
			void connectSession(body.session.id);
		} catch (reason) {
			setSessionError(reason instanceof Error ? reason.message : "Studio could not start the local OMP session.");
		} finally {
			setSessionPending(false);
		}
	};

	const submitPrompt = useCallback(
		async (event: FormEvent<HTMLFormElement>): Promise<void> => {
			event.preventDefault();
			const message = promptText.trim();
			const images = promptImages.map(image => image.attachment);
			if (
				!selectedSessionId ||
				!selectedSessionKnown ||
				(!message && images.length === 0) ||
				promptPending ||
				promptImagePending
			) {
				return;
			}
			const studioSessionId = selectedSessionId;
			setSessionError(null);
			setPromptPending(true);
			let optimisticMessageId: string | undefined;
			try {
				// `/prompts` starts (or joins the start of) the OMP session server-side. Do not make the user's
				// first message depend on the separate best-effort warm-up request completing successfully.
				// The prompt needs a live lease, not a fresh one. Reuse an unexpired lease when possible.
				const reusedLease =
					(leaseExpiresAtMs[studioSessionId] ?? 0) - Date.now() > STUDIO_CONTROL_LEASE_REUSE_MARGIN_MS;
				const controlling = reusedLease ? Promise.resolve(true) : acquireControl(studioSessionId, false);
				if (!(await controlling)) return;
				const optimisticId = `local_${crypto.randomUUID().replaceAll("-", "")}`;
				optimisticMessageId = optimisticId;
				const promptedAtMs = Date.now();
				const sendPrompt = async (): Promise<Response> =>
					await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/prompts`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ holderId, message, ...(images.length ? { images } : {}) }),
						signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
					});
				let response = await sendPrompt();
				if (!response.ok) {
					const failure = await readResponseFailure(response);
					// A reused lease can be stale when the server restarted or another tab took control.
					if (!reusedLease || failure.code !== "control_lease_required") throw new Error(failure.message);
					if (!(await acquireControl(studioSessionId, false))) return;
					response = await sendPrompt();
					if (!response.ok) throw new Error(await responseError(response));
				}
				const body = (await response.json()) as StudioPromptResponse;
				const reconciled = reconcileStudioSession(
					body.session,
					body.run,
					runStateBySessionRef.current.get(studioSessionId),
				);
				connectedSessionIdsRef.current.add(studioSessionId);
				if (reconciled.run) runStateBySessionRef.current.set(studioSessionId, reconciled.run);
				sessionSnapshotVersionRef.current += 1;
				setSessions(current =>
					sortSessions([reconciled.session, ...current.filter(session => session.id !== reconciled.session.id)]),
				);
				setTranscriptBySession(current => ({
					...current,
					[studioSessionId]: upsertStudioTranscriptMessage(current[studioSessionId] ?? [], {
						id: optimisticId,
						studioSessionId,
						runId: body.run.id,
						role: "user",
						text: message || imageTranscriptText(images.length),
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
				setPromptImagesBySession(current => {
					const next = { ...current };
					delete next[studioSessionId];
					return next;
				});
			} catch (reason) {
				if (optimisticMessageId) {
					setTranscriptBySession(current => ({
						...current,
						[studioSessionId]: (current[studioSessionId] ?? []).filter(
							transcriptMessage => transcriptMessage.id !== optimisticMessageId,
						),
					}));
				}
				void loadSessions();
				void loadTranscript(studioSessionId);
				setSessionError(reason instanceof Error ? reason.message : "Studio could not send the prompt to OMP.");
			} finally {
				setPromptPending(false);
			}
		},
		[
			acquireControl,
			holderId,
			leaseExpiresAtMs,
			loadSessions,
			loadTranscript,
			promptImagePending,
			promptImages,
			promptPending,
			promptText,
			selectedSessionId,
			selectedSessionKnown,
		],
	);

	const cancelActiveRun = useCallback(async (): Promise<void> => {
		const run = selectedActiveRun;
		if (!selectedSessionId || !run || cancelPending) return;
		const studioSessionId = selectedSessionId;
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
	}, [acquireControl, cancelPending, holderId, loadSessions, selectedActiveRun, selectedSessionId]);

	const changeSessionMode = useCallback(
		async (mode: StudioSessionMode): Promise<void> => {
			if (
				!selectedSessionId ||
				!selectedSession ||
				selectedActiveRun ||
				sessionModePendingId !== null ||
				(selectedSession.mode ?? "code") === mode
			) {
				return;
			}
			const studioSessionId = selectedSessionId;
			if (!(await acquireControl(studioSessionId, false))) return;
			setSessionError(null);
			setSessionModePendingId(studioSessionId);
			try {
				const response = await fetch(`/api/v1/sessions/${encodeURIComponent(studioSessionId)}/mode`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ holderId, mode }),
					signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(await responseError(response));
				const body = (await response.json()) as StudioSessionResponse;
				sessionSnapshotVersionRef.current += 1;
				setSessions(current =>
					sortSessions([body.session, ...current.filter(session => session.id !== body.session.id)]),
				);
			} catch (reason) {
				setSessionError(reason instanceof Error ? reason.message : "Studio could not change the session mode.");
			} finally {
				setSessionModePendingId(current => (current === studioSessionId ? null : current));
			}
		},
		[acquireControl, holderId, selectedActiveRun, selectedSession, selectedSessionId, sessionModePendingId],
	);

	const changeSessionModel = useCallback(
		async (provider: string, modelId: string): Promise<void> => {
			if (!selectedSessionId || !selectedSession || selectedActiveRun || sessionModelPendingId !== null) return;
			if (selectedSession.model?.provider === provider && selectedSession.model.id === modelId) return;
			if (!(await acquireControl(selectedSessionId, false))) return;
			setSessionError(null);
			setSessionModelPendingId(selectedSessionId);
			try {
				const response = await fetch(`/api/v1/sessions/${encodeURIComponent(selectedSessionId)}/model`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ holderId, provider, modelId }),
					signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(await responseError(response));
				const body = (await response.json()) as StudioSessionResponse;
				sessionSnapshotVersionRef.current += 1;
				setSessions(current =>
					sortSessions([body.session, ...current.filter(session => session.id !== body.session.id)]),
				);
			} catch (reason) {
				setSessionError(reason instanceof Error ? reason.message : "Studio could not change the session model.");
			} finally {
				setSessionModelPendingId(current => (current === selectedSessionId ? null : current));
			}
		},
		[acquireControl, holderId, selectedActiveRun, selectedSession, selectedSessionId, sessionModelPendingId],
	);

	const changeSessionThinking = useCallback(
		async (thinkingLevel: StudioThinkingLevel | undefined): Promise<void> => {
			if (!selectedSessionId || !selectedSession || selectedActiveRun || sessionThinkingPendingId !== null) return;
			if (selectedSessionThinkingPicker?.kind === "model_variant") {
				if (!thinkingLevel || !selectedSessionModel) return;
				const variant = getStudioThinkingVariantModel(
					selectedSessionModel,
					selectedSessionProviderModels,
					thinkingLevel,
				);
				if (variant) await changeSessionModel(variant.providerId, variant.id);
				return;
			}
			if (!(await acquireControl(selectedSessionId, false))) return;
			setSessionError(null);
			setSessionThinkingPendingId(selectedSessionId);
			try {
				const response = await fetch(`/api/v1/sessions/${encodeURIComponent(selectedSessionId)}/thinking`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ holderId, ...(thinkingLevel ? { thinkingLevel } : {}) }),
					signal: AbortSignal.timeout(STUDIO_MUTATION_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(await responseError(response));
				const body = (await response.json()) as StudioSessionResponse;
				sessionSnapshotVersionRef.current += 1;
				setSessions(current =>
					sortSessions([body.session, ...current.filter(session => session.id !== body.session.id)]),
				);
			} catch (reason) {
				setSessionError(reason instanceof Error ? reason.message : "Studio could not change Thinking.");
			} finally {
				setSessionThinkingPendingId(current => (current === selectedSessionId ? null : current));
			}
		},
		[
			acquireControl,
			changeSessionModel,
			holderId,
			selectedActiveRun,
			selectedSession,
			selectedSessionId,
			selectedSessionModel,
			selectedSessionProviderModels,
			selectedSessionThinkingPicker?.kind,
			sessionThinkingPendingId,
		],
	);

	const resolveToolApproval = useCallback(
		async (approval: StudioApproval, decision: "approve" | "reject"): Promise<void> => {
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
		},
		[acquireControl, approvalPendingId, holderId],
	);

	useEffect(() => {
		shouldAutoScrollConversationRef.current = true;
	}, [selectedSessionId]);

	useEffect(() => {
		setNavigationOpen(false);
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
				window.requestAnimationFrame(() => sessionWorkspaceRef.current?.focus());
				return;
			}
			if (key === "o") {
				event.preventDefault();
				setProjectManagerOpen(true);
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

	// Stable render-site handlers. Inline arrows here would change identity on every render and defeat the
	// memoized rail, pane and inspector, which is what makes a 20 Hz streaming tick cheap.
	const closeNavigation = useCallback((): void => setNavigationOpen(false), []);
	const openActiveContextPanel = useCallback((): void => openContext(contextPanel), [contextPanel, openContext]);
	const handleAcquireControl = useCallback(
		(studioSessionId: string): void => void acquireControl(studioSessionId),
		[acquireControl],
	);
	const handleAddProject = useCallback((): void => {
		setProjectManagerOpen(true);
		openSetup();
		window.requestAnimationFrame(() => workspacePathRef.current?.focus());
	}, [openSetup]);
	const handleSelectSession = useCallback((studioSessionId: string): void => {
		setSelectedSessionId(studioSessionId);
		setNavigationOpen(false);
	}, []);
	const handleSelectWorkspaceId = useCallback(
		(workspaceId: string): void => {
			setSessionWorkspaceId(workspaceId);
			openSetup();
		},
		[openSetup],
	);
	const handleCancelActiveRun = useCallback((): void => void cancelActiveRun(), [cancelActiveRun]);
	const handleDraftChange = useCallback(
		(value: string): void => {
			if (!selectedSessionId) return;
			setPromptDrafts(current => ({ ...current, [selectedSessionId]: value }));
		},
		[selectedSessionId],
	);
	const handleAttachPromptImages = useCallback(
		async (files: FileList): Promise<void> => {
			if (!selectedSessionId || !selectedSessionSupportsImageInput || promptImagePending) return;
			const studioSessionId = selectedSessionId;
			const existingImages = promptImagesBySession[studioSessionId] ?? [];
			if (files.length === 0) return;
			if (existingImages.length + files.length > STUDIO_MAX_IMAGE_ATTACHMENTS) {
				setSessionError(`Attach up to ${STUDIO_MAX_IMAGE_ATTACHMENTS} images to one message.`);
				return;
			}
			setSessionError(null);
			setPromptImagePending(true);
			try {
				const attachments = await Promise.all(Array.from(files).map(readImageAttachment));
				const drafts = attachments.map((attachment, index) => ({
					id: crypto.randomUUID(),
					attachment,
					name: files[index]?.name || "Image",
				}));
				setPromptImagesBySession(current => ({
					...current,
					[studioSessionId]: [...(current[studioSessionId] ?? []), ...drafts],
				}));
			} catch (reason) {
				setSessionError(reason instanceof Error ? reason.message : "Studio could not prepare that image.");
			} finally {
				setPromptImagePending(false);
			}
		},
		[promptImagePending, promptImagesBySession, selectedSessionId, selectedSessionSupportsImageInput],
	);
	const handleRemovePromptImage = useCallback(
		(imageId: string): void => {
			if (!selectedSessionId) return;
			setPromptImagesBySession(current => {
				const nextImages = (current[selectedSessionId] ?? []).filter(image => image.id !== imageId);
				if (nextImages.length === 0) {
					const next = { ...current };
					delete next[selectedSessionId];
					return next;
				}
				return { ...current, [selectedSessionId]: nextImages };
			});
		},
		[selectedSessionId],
	);
	const handleSessionModeChange = useCallback(
		(mode: StudioSessionMode): void => void changeSessionMode(mode),
		[changeSessionMode],
	);
	const handleSessionModelChange = useCallback(
		(provider: string, modelId: string): void => void changeSessionModel(provider, modelId),
		[changeSessionModel],
	);
	const handleSessionThinkingChange = useCallback(
		(level: StudioThinkingLevel | undefined): void => void changeSessionThinking(level),
		[changeSessionThinking],
	);
	const handleReconnect = useCallback((): void => {
		if (selectedSessionId) void connectSession(selectedSessionId, true);
	}, [connectSession, selectedSessionId]);
	const handleConversationScroll = useCallback(
		(scrollHeight: number, scrollTop: number, clientHeight: number): void => {
			shouldAutoScrollConversationRef.current = scrollHeight - scrollTop - clientHeight < 40;
		},
		[],
	);
	const handleLoadEarlierTranscript = useCallback((): void => {
		if (!selectedSessionId || earlierTranscriptOrdinal === undefined) return;
		void loadEarlierTranscript(selectedSessionId, earlierTranscriptOrdinal);
	}, [earlierTranscriptOrdinal, loadEarlierTranscript, selectedSessionId]);
	const handleRefreshChanges = useCallback((): void => {
		if (selectedSessionId) void loadChangeSet(selectedSessionId);
	}, [loadChangeSet, selectedSessionId]);
	const handleRefreshHistory = useCallback((): void => {
		if (!selectedSessionId) return;
		if (runHistory) void loadRunHistory(selectedSessionId);
		if (usageHistory) void loadUsageHistory(selectedSessionId);
	}, [loadRunHistory, loadUsageHistory, runHistory, selectedSessionId, usageHistory]);
	const handleResolveApproval = useCallback(
		(approval: StudioApproval, decision: "approve" | "reject"): void => void resolveToolApproval(approval, decision),
		[resolveToolApproval],
	);

	return (
		<div className="studio-shell studio-desktop-shell">
			<StudioTitlebar
				connection={connection}
				onOpenContext={openActiveContextPanel}
				onOpenNavigation={openNavigation}
				onOpenSetup={openSetup}
				profile={profile}
				selectedSession={selectedSession ?? undefined}
			/>

			<div
				className={`studio-workspace-layout${navigationOpen ? " studio-workspace-layout-navigation-open" : ""}${contextOpen ? " studio-workspace-layout-context-open" : ""}`}
			>
				{navigationOpen && (
					<button
						aria-label="Close session navigation"
						className="studio-mobile-scrim studio-navigation-scrim"
						onClick={closeNavigation}
						type="button"
					/>
				)}
				<StudioSessionRail
					controlPendingId={controlPendingId}
					leaseExpiresAtMs={leaseExpiresAtMs}
					onAcquireControl={handleAcquireControl}
					onAddProject={handleAddProject}
					onOpenSetup={openSetup}
					onSelectSession={handleSelectSession}
					onSelectWorkspace={handleSelectWorkspaceId}
					selectedSessionId={selectedSessionId}
					sessionWorkspaceId={sessionWorkspaceId}
					sessions={sessions}
					workspaces={workspaces}
				/>

				<StudioConversationPane
					imageAttachments={promptImages}
					imageAttachmentPending={promptImagePending}
					imageInputEnabled={selectedSessionSupportsImageInput}
					modelOptions={selectedSessionProviderModels}
					selectedModel={selectedSessionModel ?? undefined}
					modelPending={sessionModelPendingId === selectedSessionId}
					thinkingLevels={selectedSessionThinkingLevels}
					selectedThinkingLevel={selectedSessionThinkingLevel}
					thinkingPending={sessionThinkingPendingId === selectedSessionId}
					cancelPending={cancelPending}
					connectionPending={selectedSessionConnecting}
					composerBlocked={composerBlocked}
					controlPending={controlPendingId !== null}
					draft={promptText}
					earlierPending={earlierTranscriptPending}
					hasEarlierTranscript={earlierTranscriptOrdinal !== undefined}
					hasStreamingAssistant={hasStreamingAssistant}
					onCancel={handleCancelActiveRun}
					onAttachImages={handleAttachPromptImages}
					onModelChange={handleSessionModelChange}
					onThinkingChange={handleSessionThinkingChange}
					onDraftChange={handleDraftChange}
					onLoadEarlier={handleLoadEarlierTranscript}
					onOpenContext={openContext}
					onOpenSetup={openSetup}
					onRemoveImage={handleRemovePromptImage}
					onReconnect={handleReconnect}
					onSessionModeChange={handleSessionModeChange}
					onScroll={handleConversationScroll}
					onSubmit={submitPrompt}
					promptPending={promptPending}
					selectedActiveRun={selectedActiveRun}
					selectedSession={selectedSession ?? undefined}
					sessionModePending={sessionModePendingId === selectedSessionId}
					selectedWorkspace={selectedWorkspace ?? undefined}
					scrollRef={conversationScrollRef}
					sessionError={sessionError}
					textareaRef={composerTextareaRef}
					transcript={displayedTranscript}
					transcriptError={transcriptError}
					transcriptLoading={transcriptLoading}
				/>

				{contextOpen && (
					<button
						aria-label="Close run context"
						className="studio-mobile-scrim studio-context-scrim"
						onClick={closeContext}
						type="button"
					/>
				)}

				{contextOpen && (
					<div className="studio-context-host">
						<StudioSessionInspector
							activePanel={contextPanel}
							activityEnabled={activityTimeline}
							activityEntries={selectedActivity}
							activityError={activityError}
							activityLoading={activityLoading}
							changeReviewEnabled={changeReview}
							changeSet={selectedChangeSet}
							changeSetError={changeSetError}
							changeSetLoading={changeSetLoading}
							plan={selectedPlan}
							planEnabled={planSummary}
							planError={planError}
							planLoading={planLoading}
							runHistory={selectedRunHistory}
							runHistoryEnabled={runHistory}
							runHistoryError={runHistoryError ?? usageHistoryError}
							runHistoryLoading={runHistoryLoading || usageHistoryLoading}
							approvalEnabled={approvalControls}
							approvalPendingId={approvalPendingId}
							approvals={selectedApprovals}
							controlPendingId={controlPendingId}
							leaseExpiresAtMs={selectedSession ? (leaseExpiresAtMs[selectedSession.id] ?? 0) : 0}
							onAcquireControl={handleAcquireControl}
							onClose={closeContext}
							onPanelChange={openContext}
							onOpenSetup={openSetup}
							onRefreshChanges={handleRefreshChanges}
							onRefreshHistory={handleRefreshHistory}
							onResolveApproval={handleResolveApproval}
							selectedActiveRun={selectedActiveRun}
							selectedSession={selectedSession ?? undefined}
							selectedWorkspace={selectedWorkspace ?? undefined}
							subagentEnabled={subagentVisibility}
							subagents={selectedSubagents}
							toolCards={selectedToolDisplays}
							toolCardsEnabled={toolCards}
							toolCardsError={toolDisplayError}
							toolCardsLoading={toolDisplayLoading}
							usageEnabled={usageSummary}
							usageHistory={selectedUsageHistory}
						/>
					</div>
				)}
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
								<span className="studio-drawer-kicker">Local workspace</span>
								<h2 id="studio-setup-heading">New session</h2>
							</div>
							<button aria-label="Close setup" onClick={() => setSetupOpen(false)} type="button">
								Close
							</button>
						</header>

						<section
							className="studio-drawer-section studio-session-start"
							aria-labelledby="studio-session-start-heading"
						>
							<div className="studio-drawer-section-heading">
								<div>
									<span>01</span>
									<h3 id="studio-session-start-heading">Start a session</h3>
								</div>
								<span>{rpcSupervisor ? "Ready" : "Unavailable"}</span>
							</div>
							{rpcSupervisor ? (
								<form className="studio-session-form" onSubmit={createSession}>
									<label className="studio-session-project-field">
										<span>Project</span>
										<div className="studio-session-project-control">
											<select
												aria-label="Project"
												disabled={sessionPending || workspaces.length === 0}
												onChange={event => setSessionWorkspaceId(event.target.value)}
												ref={sessionWorkspaceRef}
												value={sessionWorkspaceId}
											>
												<option value="">Choose a project</option>
												{workspaces.map(workspace => (
													<option key={workspace.id} value={workspace.id}>
														{workspace.label}
													</option>
												))}
											</select>
											{window.ompStudio && (
												<button
													aria-label="Add project folder"
													className="studio-session-add-project"
													disabled={sessionPending || workspacePending || workspacePickerPending}
													onClick={() => void selectWorkspace()}
													title="Add project folder"
													type="button"
												>
													<FolderPlus aria-hidden="true" size={15} strokeWidth={1.8} />
												</button>
											)}
										</div>
										{quickStartWorkspaces.length > 1 && (
											<div aria-label="Recent projects" className="studio-session-recent-projects">
												<span>Recent</span>
												{quickStartWorkspaces.map(workspace => (
													<button
														aria-pressed={workspace.id === sessionWorkspaceId}
														className={
															workspace.id === sessionWorkspaceId
																? "studio-session-recent-active"
																: undefined
														}
														onClick={() => setSessionWorkspaceId(workspace.id)}
														title={workspace.label}
														type="button"
													>
														{workspace.label}
													</button>
												))}
											</div>
										)}
									</label>
									<label>
										<span>Provider</span>
										<select
											aria-label="Provider"
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
									{providers.every(provider => provider.models.length === 0) && (
										<button
											className="studio-session-provider-setup"
											onClick={() => setProviderManagerOpen(true)}
											type="button"
										>
											Connect a provider
										</button>
									)}
									<label>
										<span>Model</span>
										<select
											aria-label="Model"
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
									<fieldset className="studio-session-mode-field">
										<legend>Mode</legend>
										<div aria-label="Session mode" className="studio-mode-segmented" role="group">
											<button
												aria-pressed={sessionMode === "code"}
												className={sessionMode === "code" ? "studio-mode-option-active" : undefined}
												disabled={sessionPending}
												onClick={() => setSessionMode("code")}
												type="button"
											>
												Code
											</button>
											<button
												aria-pressed={sessionMode === "plan"}
												className={sessionMode === "plan" ? "studio-mode-option-active" : undefined}
												disabled={sessionPending}
												onClick={() => setSessionMode("plan")}
												type="button"
											>
												Plan
											</button>
										</div>
									</fieldset>
									<details className="studio-session-advanced">
										<summary>Optional session name</summary>
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
									</details>
									<div className="studio-drawer-form-actions">
										<button
											aria-describedby={sessionStartBlockedReason ? "studio-session-requirement" : undefined}
											disabled={sessionPending || sessionStartBlockedReason !== null}
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

						<section className="studio-drawer-section" aria-labelledby="studio-workspaces-heading">
							<div className="studio-drawer-section-heading">
								<div>
									<span>02</span>
									<h3 id="studio-workspaces-heading">Project folders</h3>
								</div>
								<div className="studio-drawer-section-heading-actions">
									<span>{workspaces.length}</span>
									<button
										aria-expanded={projectManagerOpen}
										aria-label={projectManagerOpen ? "Hide project folders" : "Show project folders"}
										className="studio-drawer-disclosure"
										onClick={() => setProjectManagerOpen(current => !current)}
										title={projectManagerOpen ? "Hide project folders" : "Show project folders"}
										type="button"
									>
										<ChevronDown
											aria-hidden="true"
											className={projectManagerOpen ? "studio-drawer-disclosure-open" : undefined}
											size={15}
											strokeWidth={1.8}
										/>
									</button>
								</div>
							</div>
							{projectManagerOpen && (
								<>
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
														{workspaceRemovalPendingId === workspace.id ? "Removing" : "Remove"}
													</button>
												</div>
											))}
										</div>
									)}
								</>
							)}
						</section>

						<section className="studio-drawer-section" aria-labelledby="studio-providers-heading">
							<div className="studio-drawer-section-heading">
								<div>
									<span>03</span>
									<h3 id="studio-providers-heading">Provider</h3>
								</div>
								<div className="studio-drawer-section-heading-actions">
									<span>
										{providers.filter(provider => provider.authState !== "unconfigured").length} ready
									</span>
									<button
										aria-expanded={providerManagerOpen}
										aria-label={providerManagerOpen ? "Hide provider setup" : "Show provider setup"}
										className="studio-drawer-disclosure"
										onClick={() => setProviderManagerOpen(current => !current)}
										title={providerManagerOpen ? "Hide provider setup" : "Show provider setup"}
										type="button"
									>
										<ChevronDown
											aria-hidden="true"
											className={providerManagerOpen ? "studio-drawer-disclosure-open" : undefined}
											size={15}
											strokeWidth={1.8}
										/>
									</button>
								</div>
							</div>
							{providerManagerOpen ? (
								providerOnboarding ? (
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
								)
							) : null}
						</section>
					</aside>
				</div>
			)}

			{error && <p className="studio-app-error">{error}</p>}
		</div>
	);
}
