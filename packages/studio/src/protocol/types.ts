export const STUDIO_API_VERSION = 1 as const;

export interface StudioFeatures {
	localAccess: boolean;
	webSocketEvents: boolean;
	eventRecovery: boolean;
	workspaceRegistry: boolean;
	providerOnboarding: boolean;
	rpcSupervisor: boolean;
	approvalControls: boolean;
	subagentVisibility: boolean;
	usageSummary: boolean;
	activityTimeline: boolean;
	toolCards: boolean;
	planSummary: boolean;
	changeReview: boolean;
	runHistory: boolean;
	usageHistory: boolean;
	auditReview: boolean;
}

export interface StudioBootstrap {
	apiVersion: typeof STUDIO_API_VERSION;
	mode: "local-single-user";
	profile: string;
	/** The OMP runtime version the running sidecar reports about itself. */
	runtimeVersion: string;
	features: StudioFeatures;
}

/** Browser-safe workspace metadata. Canonical filesystem paths remain server-side. */
export interface StudioWorkspace {
	id: string;
	label: string;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface StudioWorkspaceListResponse {
	workspaces: StudioWorkspace[];
}

export interface StudioWorkspaceResponse {
	workspace: StudioWorkspace;
}

/** Browser-safe model selection persisted for one Studio session. */
export interface StudioModelSelection {
	provider: string;
	id: string;
	thinkingLevel?: StudioThinkingLevel;
}

/** Stable effort labels shared by the Studio picker and OMP's CLI parser. */
export type StudioThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The compact workflow choice for one Studio session. */
export type StudioSessionMode = "code" | "plan";

/** An image payload accepted by the OMP RPC prompt command. */
export interface StudioImageAttachment {
	type: "image";
	data: string;
	mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export const STUDIO_MAX_IMAGE_ATTACHMENTS = 4;
export const STUDIO_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Runtime availability of a Studio session. OMP session paths never appear in this state. */
export type StudioSessionStatus = "starting" | "ready" | "running" | "interrupted" | "failed";

/** Lifecycle of one submitted prompt. */
export type StudioRunStatus =
	| "starting"
	| "running"
	| "cancelling"
	| "completed"
	| "cancelled"
	| "interrupted"
	| "failed";

/** A fixed, browser-safe category for a provider-side terminal failure. */
export type StudioRunFailureKind =
	| "authentication"
	| "rate_limit"
	| "context_limit"
	| "connection"
	| "policy"
	| "provider";

export interface StudioRun {
	id: string;
	studioSessionId: string;
	status: StudioRunStatus;
	rpcProtocolVersion?: number;
	startedAtMs: number;
	endedAtMs?: number;
	interruptedReason?: string;
	failureKind?: StudioRunFailureKind;
}

/** A durable Studio session summary safe to return to the local browser. */
export interface StudioSession {
	id: string;
	profile: string;
	workspaceId: string;
	name?: string;
	model?: StudioModelSelection;
	mode?: StudioSessionMode;
	status: StudioSessionStatus;
	createdAtMs: number;
	updatedAtMs: number;
	lastActivityAtMs?: number;
	activeRun?: StudioRun;
	usage?: StudioUsage;
}

export interface StudioSessionListResponse {
	sessions: StudioSession[];
}

export interface StudioSessionResponse {
	session: StudioSession;
}

export interface StudioPromptResponse {
	run: StudioRun;
	session: StudioSession;
}

/**
 * Browser-safe text exchanged during a Studio run. Tool arguments, tool
 * results, provider payloads, and native session identifiers are deliberately
 * absent from this shape.
 */
export type StudioTranscriptMessageRole = "user" | "assistant";

export type StudioTranscriptMessageStatus = "streaming" | "completed" | "failed" | "interrupted";

export interface StudioTranscriptMessage {
	id: string;
	studioSessionId: string;
	runId: string;
	role: StudioTranscriptMessageRole;
	text: string;
	status: StudioTranscriptMessageStatus;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface StudioTranscriptResponse {
	messages: StudioTranscriptMessage[];
	/** Present when older messages exist; pass it back as `before` to fetch the previous page. */
	nextBeforeOrdinal?: number;
}

/** A fixed, browser-safe category for one durable Studio run activity event. */
export type StudioActivitySubject =
	| "agent"
	| "command"
	| "file_read"
	| "file_write"
	| "file_search"
	| "web"
	| "task"
	| "context"
	| "retry"
	| "tool"
	| "system";

/** The rendered outcome of a Studio activity event. */
export type StudioActivityStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Durable browser-safe activity. Native tool names, arguments, output, paths,
 * provider payloads, and other raw OMP fields never appear in this shape.
 */
export interface StudioActivityEntry {
	id: string;
	studioSessionId: string;
	runId: string;
	subject: StudioActivitySubject;
	status: StudioActivityStatus;
	occurredAtMs: number;
}

export interface StudioActivityListResponse {
	entries: StudioActivityEntry[];
}

/** A browser-safe, fixed category for one projected OMP tool operation. */
export type StudioToolDisplayKind = "command" | "file_read" | "file_write" | "file_search" | "web" | "task" | "tool";

/** Tool-card lifecycle mirrors the only outcomes Studio may disclose. */
export type StudioToolDisplayStatus = StudioActivityStatus;

interface StudioToolDisplayBase<TKind extends StudioToolDisplayKind> {
	id: string;
	studioSessionId: string;
	runId: string;
	kind: TKind;
	status: StudioToolDisplayStatus;
	startedAtMs: number;
	updatedAtMs: number;
}

/**
 * A server-projected tool card. The discriminant carries a fixed operation
 * family only; native tool names, arguments, output, and paths are absent.
 */
export type StudioToolDisplay =
	| StudioToolDisplayBase<"command">
	| StudioToolDisplayBase<"file_read">
	| StudioToolDisplayBase<"file_write">
	| StudioToolDisplayBase<"file_search">
	| StudioToolDisplayBase<"web">
	| StudioToolDisplayBase<"task">
	| StudioToolDisplayBase<"tool">;

export interface StudioToolDisplayListResponse {
	cards: StudioToolDisplay[];
}

/**
 * Aggregate plan progress. Task descriptions and blockers remain inside the
 * OMP session, while fixed counters let the workbench show current progress.
 */
export interface StudioPlanSummary {
	studioSessionId: string;
	runId: string;
	totalTaskCount: number;
	pendingTaskCount: number;
	inProgressTaskCount: number;
	completedTaskCount: number;
	blockedTaskCount: number;
	abandonedTaskCount: number;
	updatedAtMs: number;
}

export interface StudioPlanSummaryResponse {
	plan?: StudioPlanSummary;
}

/** The only Git change states that may be rendered by the Studio browser. */
export type StudioChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

/** A bounded line in a server-projected diff preview. */
export interface StudioChangePreviewLine {
	kind: "context" | "addition" | "deletion";
	text: string;
}

/** Numeric hunk coordinates plus a bounded, redacted preview. */
export interface StudioChangePreviewHunk {
	oldStart: number;
	oldLineCount: number;
	newStart: number;
	newLineCount: number;
	lines: StudioChangePreviewLine[];
	truncated: boolean;
}

/**
 * A project-relative file change. Absolute paths, raw Git output, and
 * unrestricted file content never cross this browser boundary.
 */
export interface StudioChangeFile {
	path: string;
	status: StudioChangeStatus;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	binary: boolean;
	additions: number;
	deletions: number;
	previewOmitted: boolean;
	previewTruncated: boolean;
	hunks: StudioChangePreviewHunk[];
}

/** A fresh, non-persisted review snapshot for one registered workspace. */
export interface StudioChangeSet {
	generatedAtMs: number;
	fileCount: number;
	stagedFileCount: number;
	unstagedFileCount: number;
	untrackedFileCount: number;
	additions: number;
	deletions: number;
	truncated: boolean;
	files: StudioChangeFile[];
}

export interface StudioChangeSetResponse {
	changeSet: StudioChangeSet;
}

export interface StudioRunResponse {
	run: StudioRun;
}

/** Bounded durable run history for one Studio session. */
export interface StudioRunHistoryResponse {
	runs: StudioRun[];
}

/** Last known token and cost totals for a Studio session, sourced from OMP RPC. */
export interface StudioUsage {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	premiumRequests: number;
	cost: number;
	toolCalls: number;
	contextTokens?: number;
	contextWindow?: number;
	updatedAtMs: number;
}

export interface StudioUsageResponse {
	usage?: StudioUsage;
}

/** A bounded usage sample associated with one browser-safe Studio run. */
export interface StudioUsageHistoryEntry {
	id: string;
	studioSessionId: string;
	runId: string;
	usage: StudioUsage;
}

export interface StudioUsageHistoryResponse {
	entries: StudioUsageHistoryEntry[];
}

/** Browser-safe summary of a subagent. Session-file paths and raw tool arguments stay server-side. */
export interface StudioSubagent {
	id: string;
	index: number;
	agent: string;
	agentSource: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	description?: string;
	task?: string;
	toolCount?: number;
	requestCount?: number;
	tokenCount?: number;
	cost?: number;
	updatedAtMs: number;
}

export interface StudioSubagentListResponse {
	subagents: StudioSubagent[];
}

/** Browser-safe lifecycle metadata. Native tool names, IDs, paths, arguments, and output are omitted. */
export interface StudioAgentEvent {
	type: string;
	failureKind?: StudioRunFailureKind;
	isError?: boolean;
	isTerminal?: boolean;
}

export type StudioApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "interrupted";

/** One-time decision for a live OMP tool call. The argument digest detects changed input without exposing it. */
export interface StudioApproval {
	id: string;
	runId: string;
	studioSessionId: string;
	toolCallId: string;
	toolName: string;
	argumentsDigest: string;
	status: StudioApprovalStatus;
	requestedAtMs: number;
	expiresAtMs: number;
	reason?: string;
	resolvedAtMs?: number;
	resolutionReason?: string;
}

export interface StudioApprovalListResponse {
	approvals: StudioApproval[];
}

export interface StudioApprovalResponse {
	approval: StudioApproval;
}

export interface StudioApprovalResolutionRequest {
	holderId: string;
	decision: "approve" | "reject";
}

/** Browser-safe fields retained with an audit entry. Arbitrary request data is never eligible for this shape. */
export type StudioAuditDetail = Partial<
	Record<
		"approvalId" | "argumentsDigest" | "modelId" | "provider" | "reason" | "rpcProtocolVersion" | "toolName",
		boolean | number | string
	>
>;

/** A bounded, local-only record of a Studio control-plane transition. */
export interface StudioAuditEntry {
	id: number;
	occurredAtMs: number;
	action: string;
	studioSessionId?: string;
	runId?: string;
	detail: StudioAuditDetail;
}

export interface StudioAuditListResponse {
	entries: StudioAuditEntry[];
	nextBeforeId?: number;
}

/** Phase 15: Terminal session metadata (PTY owned by Studio server, bytes never cross boundary) */
export interface StudioTerminalSession {
	id: string;
	studioSessionId: string;
	workspaceId: string;
	title: string;
	status: "active" | "closed" | "error";
	createdAtMs: number;
	cols: number;
	rows: number;
}

/** Phase 15: Terminal output chunk — size-capped, ephemeral streaming */
export interface StudioTerminalOutput {
	terminalId: string;
	studioSessionId: string;
	sequence: number;
	data: string;
	truncated: boolean;
}

/** Phase 15: Terminal resize — client→server only */
export interface StudioTerminalResize {
	terminalId: string;
	studioSessionId: string;
	cols: number;
	rows: number;
}

/** Phase 16: Browser tab metadata — no cookies, storage, or raw page content */
export interface StudioBrowserTab {
	id: string;
	studioSessionId: string;
	profileId: string;
	title: string;
	url: string;
	status: "loading" | "active" | "crashed" | "closed";
	agentGranted: boolean;
	createdAtMs: number;
}

/** Phase 16: Browser navigation — every URL audited; agent commands via IPC-only */
export interface StudioBrowserNavigation {
	tabId: string;
	studioSessionId: string;
	url: string;
	transitionType: "user" | "agent" | "reload" | "back" | "forward";
	timestampMs: number;
}

/** Phase 16: Browser screenshot — bounded artifact with size cap (≤512 KiB) */
export interface StudioBrowserScreenshot {
	tabId: string;
	studioSessionId: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	data: string; // base64
	sizeBytes: number;
	capturedAtMs: number;
}

/** Phase 16: Browser agent grant — per-tab, immediate revocation, no cookie/storage access */
export interface StudioBrowserGrant {
	tabId: string;
	studioSessionId: string;
	grantedTo: "agent" | "user";
	grantedAtMs: number;
	revokedAtMs?: number;
	revokedBy?: "user" | "navigate" | "profile-switch" | "data-clear";
}

/** Phase 17: Voice turn — text only, follows transcript projection */
export interface StudioVoiceTurn {
	id: string;
	studioSessionId: string;
	runId: string;
	role: "user" | "assistant";
	text: string;
	status: "streaming" | "completed" | "failed" | "interrupted";
	createdAtMs: number;
}

/** Phase 17: Voice audio buffer — ephemeral, desktop-only, discarded after STT unless explicit save */
export interface StudioVoiceAudio {
	studioSessionId: string;
	sequence: number;
	mimeType: string; // audio/*
	data: string; // base64
	durationMs: number;
	isFinal: boolean;
}

/** Phase 18: Workflow graph — authored in desktop shell, executed against real runs */
export interface StudioWorkflowGraph {
	id: string;
	studioSessionId: string;
	name: string;
	nodes: StudioWorkflowNode[];
	edges: StudioWorkflowEdge[];
	status: "idle" | "running" | "completed" | "failed" | "cancelled";
	createdAtMs: number;
	updatedAtMs: number;
}

/** Phase 18: Workflow node — per-node state observable in inspector */
export interface StudioWorkflowNode {
	id: string;
	graphId: string;
	type: "prompt" | "tool" | "approval" | "subagent" | "merge";
	label: string;
	status: "idle" | "running" | "completed" | "failed" | "cancelled";
	position: { x: number; y: number };
	inputs: Record<string, unknown>;
	outputs: Record<string, unknown>;
	startedAtMs?: number;
	updatedAtMs: number;
}

/** Phase 18: Workflow edge — semantics projected, not raw DSL */
export interface StudioWorkflowEdge {
	id: string;
	graphId: string;
	source: string;
	target: string;
	type: "sequence" | "parallel" | "conditional";
	condition?: string;
}

export interface StudioSessionCreateRequest {
	workspaceId: string;
	provider: string;
	modelId: string;
	mode?: StudioSessionMode;
	thinkingLevel?: StudioThinkingLevel;
	holderId: string;
	name?: string;
}

export interface StudioPromptRequest {
	holderId: string;
	message: string;
	images?: StudioImageAttachment[];
}

/** A lease view never reveals a different tab's holder capability. */
export interface StudioControlLeaseState {
	expiresAtMs: number;
	heldByRequester: boolean;
}

export interface StudioControlLeaseRequest {
	holderId: string;
	ttlMs?: number;
}

export interface StudioControlLeaseResponse {
	lease: StudioControlLeaseState;
}

export interface StudioRunCancelRequest {
	holderId: string;
}

/** Where OMP resolved the active provider credential without exposing credential data. */
export type StudioCredentialOrigin = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

/** Browser-safe availability state for one OMP provider. */
export type StudioProviderAuthState = "authenticated" | "keyless" | "unconfigured";

/** A model that can currently be selected by a later Studio session flow. */
export interface StudioProviderModel {
	id: string;
	name: string;
	providerId: string;
	reasoning: boolean;
	thinkingLevels?: StudioThinkingLevel[];
	supportsImageInput: boolean;
	supportsTools: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

/** Provider metadata deliberately filtered to exclude credential ids, paths, and secrets. */
export interface StudioProvider {
	id: string;
	name: string;
	authState: StudioProviderAuthState;
	credentialOrigin?: StudioCredentialOrigin;
	canLogin: boolean;
	models: StudioProviderModel[];
}

export interface StudioProviderListResponse {
	providers: StudioProvider[];
}

export interface StudioProviderLoginResponse {
	flowId: string;
	providerId: string;
}

export interface StudioAuthContinueResponse {
	flowId: string;
	accepted: true;
}

export interface StudioAuthCancelResponse {
	flowId: string;
	cancelled: true;
}

export type StudioAuthProgressPhase = "authorization" | "progress" | "prompt" | "completed" | "failed" | "cancelled";

export interface StudioAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty: boolean;
}

/** A non-secret authentication step delivered on the authenticated Studio event stream. */
export interface StudioAuthProgress {
	flowId: string;
	providerId: string;
	phase: StudioAuthProgressPhase;
	message?: string;
	authorizationUrl?: string;
	launchUrl?: string;
	instructions?: string;
	prompt?: StudioAuthPrompt;
}

export interface StudioError {
	code: string;
	message: string;
}

export interface StudioErrorResponse {
	error: StudioError;
}

/** A reconnect cursor predates the bounded in-memory event history, so REST snapshots are required. */
export interface StudioEventResyncRequired {
	afterSequence: number;
	earliestAvailableSequence?: number;
	latestSequence: number;
}

export type StudioEventType =
	| "studio.ready"
	| "studio.resync_required"
	| "studio.error"
	| "run.state"
	| "transcript.updated"
	| "activity.updated"
	| "tool.display_updated"
	| "plan.updated"
	| "agent.event"
	| "approval.requested"
	| "approval.resolved"
	| "subagent.state"
	| "usage.updated"
	| "auth.progress"
	| "terminal.session"
	| "terminal.output"
	| "terminal.resize"
	| "browser.tab"
	| "browser.navigation"
	| "browser.screenshot"
	| "browser.grant"
	| "voice.turn"
	| "voice.audio"
	| "workflow.graph"
	| "workflow.node"
	| "workflow.edge";

export interface StudioEventEnvelope<TData = unknown> {
	version: typeof STUDIO_API_VERSION;
	sequence: number;
	type: StudioEventType;
	emittedAtMs: number;
	studioSessionId?: string;
	runId?: string;
	data: TData;
}
