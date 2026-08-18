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
	auditReview: boolean;
}

export interface StudioBootstrap {
	apiVersion: typeof STUDIO_API_VERSION;
	mode: "local-single-user";
	profile: string;
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
}

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

export interface StudioRun {
	id: string;
	studioSessionId: string;
	status: StudioRunStatus;
	rpcProtocolVersion?: number;
	startedAtMs: number;
	endedAtMs?: number;
	interruptedReason?: string;
}

/** A durable Studio session summary safe to return to the local browser. */
export interface StudioSession {
	id: string;
	profile: string;
	workspaceId: string;
	name?: string;
	model?: StudioModelSelection;
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
}

export interface StudioRunResponse {
	run: StudioRun;
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

/** Redacted event shape sent to the browser. Raw messages, paths, arguments, and tool output are omitted. */
export interface StudioAgentEvent {
	type: string;
	isError?: boolean;
	isTerminal?: boolean;
	toolCallId?: string;
	toolName?: string;
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

export interface StudioSessionCreateRequest {
	workspaceId: string;
	provider: string;
	modelId: string;
	holderId: string;
	name?: string;
}

export interface StudioPromptRequest {
	holderId: string;
	message: string;
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
	| "agent.event"
	| "approval.requested"
	| "approval.resolved"
	| "subagent.state"
	| "usage.updated"
	| "auth.progress";

export interface StudioEventEnvelope<TData = unknown> {
	version: typeof STUDIO_API_VERSION;
	sequence: number;
	type: StudioEventType;
	emittedAtMs: number;
	studioSessionId?: string;
	runId?: string;
	data: TData;
}
