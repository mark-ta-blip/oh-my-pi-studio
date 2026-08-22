import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { decodeEmbeddedArchive, extractEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { ensureStudioClientBuild, STUDIO_CLIENT_DIST_DIR } from "./build-client";
import { type StudioAuthBridge, StudioAuthBridgeError, StudioAuthFlowCoordinator } from "./core/auth-bridge";
import { type StudioChangeReviewAdapter, StudioChangeReviewError } from "./core/change-review";
import {
	StudioRpcSupervisor,
	StudioRpcSupervisorError,
	type StudioRpcSupervisorEvents,
	type StudioRpcTransportFactory,
} from "./core/rpc-supervisor";
import {
	type ListStudioTranscriptMessagesInput,
	MAX_STUDIO_TRANSCRIPT_PAGE_SIZE,
	StudioStore,
} from "./core/studio-store";
import { resolveWorkspaceRegistration, WorkspaceRegistrationError } from "./core/workspace-registry";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import {
	STUDIO_API_VERSION,
	STUDIO_MAX_IMAGE_ATTACHMENTS,
	STUDIO_MAX_IMAGE_BYTES,
	type StudioActivityListResponse,
	type StudioApprovalListResponse,
	type StudioApprovalResolutionRequest,
	type StudioApprovalResponse,
	type StudioAuditListResponse,
	type StudioAuthCancelResponse,
	type StudioAuthContinueResponse,
	type StudioAuthProgress,
	type StudioBootstrap,
	type StudioChangeSetResponse,
	type StudioControlLeaseRequest,
	type StudioControlLeaseResponse,
	type StudioErrorResponse,
	type StudioEventEnvelope,
	type StudioEventResyncRequired,
	type StudioEventType,
	type StudioFeatures,
	type StudioImageAttachment,
	type StudioModelSelection,
	type StudioPlanSummaryResponse,
	type StudioPromptRequest,
	type StudioPromptResponse,
	type StudioProviderListResponse,
	type StudioProviderLoginResponse,
	type StudioRunCancelRequest,
	type StudioRunHistoryResponse,
	type StudioRunResponse,
	type StudioSessionCreateRequest,
	type StudioSessionListResponse,
	type StudioSessionMode,
	type StudioSessionResponse,
	type StudioSubagentListResponse,
	type StudioThinkingLevel,
	type StudioToolDisplayListResponse,
	type StudioTranscriptResponse,
	type StudioUsageHistoryResponse,
	type StudioWorkspaceListResponse,
	type StudioWorkspaceResponse,
} from "./protocol";

export const STUDIO_DEFAULT_PORT = 4317;
export const STUDIO_HOSTNAME = "127.0.0.1";

const STUDIO_COOKIE_NAME = "omp_studio_session";
const STUDIO_EVENT_TIMEOUT_MS = 1_000;
const STUDIO_EVENT_REPLAY_LIMIT = 256;
const STUDIO_CONTROL_LEASE_DEFAULT_TTL_MS = 45_000;
const STUDIO_CONTROL_LEASE_MAX_TTL_MS = 300_000;
const STUDIO_CONTROL_LEASE_MIN_TTL_MS = 5_000;
const STUDIO_CHANGE_REVIEW_TIMEOUT_MS = 10_000;
const STUDIO_MAX_PROMPT_LENGTH = 100_000;
const STUDIO_MAX_SESSION_NAME_LENGTH = 120;
const EMBEDDED_CLIENT_ARCHIVE = decodeEmbeddedArchive(embeddedClientArchiveTxt);
const IS_BUN_COMPILED =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.PI_BUNDLED || Bun.env.PI_BUNDLED);
// Source checkouts must serve the freshly built dist/client tree. The generated
// archive is reserved for compiled binaries and prepacked bundles, where the
// source tree is not shipped alongside the server.
const USE_EMBEDDED_CLIENT = IS_PREBUILT;
const EMBEDDED_CLIENT_DIR_ROOT = path.join(os.tmpdir(), "omp-studio-client");

let embeddedClientDirPromise: Promise<string> | null = null;

interface StudioRuntime {
	auth: StudioAuthFlowCoordinator;
	changeReviewAdapter: StudioChangeReviewAdapter | undefined;
	eventHistory: StudioEventEnvelope<unknown>[];
	localUrlToken: string;
	localUrlTokenConsumed: boolean;
	nextSequence: number;
	origin: string;
	profile: string;
	sessionToken: string;
	sockets: Set<StudioEventSocket>;
	store: StudioStore;
	supervisor: StudioRpcSupervisor;
}

interface StudioWebSocketData {
	afterSequence?: number;
	connectedAtMs: number;
}

type StudioEventSocket = Pick<Bun.ServerWebSocket<StudioWebSocketData>, "send">;

type BunWebSocketConstructor = new (url: string, options: Bun.WebSocketOptions) => WebSocket;

// tsgo includes lib.dom, whose narrower WebSocket constructor omits Bun's
// server-side request-header options despite Bun exposing them at runtime.
const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

export interface StudioServerOptions {
	authBridge?: StudioAuthBridge;
	changeReviewAdapter?: StudioChangeReviewAdapter;
	dbPath?: string;
	port?: number;
	rpcTransportFactory?: StudioRpcTransportFactory;
}

export interface StudioServer {
	hostname: string;
	port: number;
	origin: string;
	url: string;
	stop(): void;
}

function createAccessToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

function getBootstrap(
	profile: string,
	providerOnboarding: boolean,
	rpcSupervisor: boolean,
	changeReview: boolean,
): StudioBootstrap {
	const features: StudioFeatures = {
		localAccess: true,
		webSocketEvents: true,
		eventRecovery: true,
		workspaceRegistry: true,
		providerOnboarding,
		rpcSupervisor,
		approvalControls: rpcSupervisor,
		subagentVisibility: rpcSupervisor,
		usageSummary: rpcSupervisor,
		activityTimeline: rpcSupervisor,
		toolCards: rpcSupervisor,
		planSummary: rpcSupervisor,
		changeReview,
		runHistory: rpcSupervisor,
		usageHistory: rpcSupervisor,
		auditReview: true,
	};
	return {
		apiVersion: STUDIO_API_VERSION,
		mode: "local-single-user",
		profile,
		features,
	};
}

function getCookie(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) continue;
		if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
	}
	return null;
}

function hasStudioAccess(request: Request, runtime: StudioRuntime): boolean {
	return getCookie(request, STUDIO_COOKIE_NAME) === runtime.sessionToken;
}

function hasAllowedOrigin(request: Request, origin: string): boolean {
	const suppliedOrigin = request.headers.get("origin");
	return suppliedOrigin === null || suppliedOrigin === origin;
}

function studioResponse(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	headers.set(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none';",
	);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Frame-Options", "DENY");
	headers.set("X-Omp-Studio-Api-Version", String(STUDIO_API_VERSION));
	return new Response(response.body, { status: response.status, headers });
}

function errorResponse(status: number, code: string, message: string): Response {
	const body: StudioErrorResponse = { error: { code, message } };
	return studioResponse(Response.json(body, { status }));
}

function jsonResponse<T>(body: T, status = 200): Response {
	return studioResponse(Response.json(body, { status }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

class StudioRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StudioRequestError";
	}
}

async function readJsonRecord(request: Request, message: string): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new StudioRequestError("invalid_request", message);
	}
	if (!isRecord(body)) throw new StudioRequestError("invalid_request", message);
	return body;
}

function requireHolderId(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
		throw new StudioRequestError("invalid_holder_id", "Studio control requests require a valid local holder ID.");
	}
	return value;
}

function requireModelValue(value: unknown, field: "provider" | "modelId"): string {
	if (typeof value !== "string") {
		throw new StudioRequestError("invalid_session_request", `Studio session ${field} must be a string.`);
	}
	const normalized = value.trim();
	if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new StudioRequestError("invalid_session_request", `Studio session ${field} is invalid.`);
	}
	if (field === "provider" && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
		throw new StudioRequestError("invalid_session_request", "Studio session provider is invalid.");
	}
	return normalized;
}

function isStudioThinkingLevel(value: unknown): value is StudioThinkingLevel {
	return (
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isStudioImageMimeType(value: unknown): value is StudioImageAttachment["mimeType"] {
	return value === "image/jpeg" || value === "image/png" || value === "image/webp" || value === "image/gif";
}

function isStudioImageData(value: string): boolean {
	return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function imageDataByteLength(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

async function readSessionCreateRequest(request: Request): Promise<StudioSessionCreateRequest> {
	const body = await readJsonRecord(request, "Studio session creation requires a JSON request body.");
	if (typeof body.workspaceId !== "string" || !/^wsp_[a-f0-9]{32}$/.test(body.workspaceId)) {
		throw new StudioRequestError("invalid_session_request", "Studio session workspaceId is invalid.");
	}
	if (body.name !== undefined && typeof body.name !== "string") {
		throw new StudioRequestError("invalid_session_request", "Studio session name must be a string.");
	}
	const name = typeof body.name === "string" ? body.name.trim() : undefined;
	const mode = body.mode === undefined ? "code" : body.mode;
	if (mode !== "code" && mode !== "plan") {
		throw new StudioRequestError("invalid_session_request", "Studio session mode must be code or plan.");
	}
	const thinkingLevel = body.thinkingLevel;
	if (thinkingLevel !== undefined && !isStudioThinkingLevel(thinkingLevel)) {
		throw new StudioRequestError("invalid_session_request", "Studio session thinking level is invalid.");
	}
	if (
		name !== undefined &&
		(!name || name.length > STUDIO_MAX_SESSION_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name))
	) {
		throw new StudioRequestError("invalid_session_request", "Studio session name is invalid.");
	}
	return {
		workspaceId: body.workspaceId,
		provider: requireModelValue(body.provider, "provider"),
		modelId: requireModelValue(body.modelId, "modelId"),
		mode,
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		holderId: requireHolderId(body.holderId),
		...(name === undefined ? {} : { name }),
	};
}

async function readControlLeaseRequest(request: Request): Promise<StudioControlLeaseRequest> {
	const body = await readJsonRecord(request, "Studio control lease requests require a JSON request body.");
	if (body.ttlMs !== undefined && (!Number.isInteger(body.ttlMs) || typeof body.ttlMs !== "number")) {
		throw new StudioRequestError("invalid_lease_request", "Studio control lease ttlMs must be an integer.");
	}
	const ttlMs = body.ttlMs as number | undefined;
	if (ttlMs !== undefined && (ttlMs < STUDIO_CONTROL_LEASE_MIN_TTL_MS || ttlMs > STUDIO_CONTROL_LEASE_MAX_TTL_MS)) {
		throw new StudioRequestError(
			"invalid_lease_request",
			`Studio control lease ttlMs must be from ${STUDIO_CONTROL_LEASE_MIN_TTL_MS} to ${STUDIO_CONTROL_LEASE_MAX_TTL_MS}.`,
		);
	}
	return { holderId: requireHolderId(body.holderId), ...(ttlMs === undefined ? {} : { ttlMs }) };
}

async function readPromptRequest(request: Request): Promise<StudioPromptRequest> {
	const body = await readJsonRecord(request, "Studio prompts require a JSON request body.");
	if (typeof body.message !== "string" || body.message.length > STUDIO_MAX_PROMPT_LENGTH) {
		throw new StudioRequestError("invalid_prompt", "Studio prompt text must be within the maximum length.");
	}
	const message = body.message.trim();
	let images: StudioPromptRequest["images"];
	if (body.images !== undefined) {
		if (!Array.isArray(body.images) || body.images.length > STUDIO_MAX_IMAGE_ATTACHMENTS) {
			throw new StudioRequestError("invalid_prompt", "Studio prompts may include up to four images.");
		}
		images = body.images.map(image => {
			if (
				!isRecord(image) ||
				image.type !== "image" ||
				typeof image.data !== "string" ||
				typeof image.mimeType !== "string" ||
				!isStudioImageMimeType(image.mimeType) ||
				!image.data ||
				image.data.length > Math.ceil(STUDIO_MAX_IMAGE_BYTES / 3) * 4 ||
				!isStudioImageData(image.data)
			) {
				throw new StudioRequestError("invalid_prompt", "Studio image attachment is invalid.");
			}
			if (imageDataByteLength(image.data) > STUDIO_MAX_IMAGE_BYTES) {
				throw new StudioRequestError("invalid_prompt", "Studio image attachment is too large.");
			}
			return { type: "image", data: image.data, mimeType: image.mimeType };
		});
	}
	if (!message && !images?.length) {
		throw new StudioRequestError("invalid_prompt", "Studio prompts must include text or an image.");
	}
	return { holderId: requireHolderId(body.holderId), message, ...(images?.length ? { images } : {}) };
}

async function readSessionModeRequest(request: Request): Promise<{ holderId: string; mode: StudioSessionMode }> {
	const body = await readJsonRecord(request, "Studio session mode changes require a JSON request body.");
	if (body.mode !== "code" && body.mode !== "plan") {
		throw new StudioRequestError("invalid_session_mode", "Studio session mode must be code or plan.");
	}
	return { holderId: requireHolderId(body.holderId), mode: body.mode };
}

async function readSessionModelRequest(request: Request): Promise<{ holderId: string; model: StudioModelSelection }> {
	const body = await readJsonRecord(request, "Studio session model changes require a JSON request body.");
	const provider = requireModelValue(body.provider, "provider");
	const modelId = requireModelValue(body.modelId, "modelId");
	const thinkingLevel = body.thinkingLevel;
	if (thinkingLevel !== undefined && !isStudioThinkingLevel(thinkingLevel)) {
		throw new StudioRequestError("invalid_session_request", "Studio session thinking level is invalid.");
	}
	return {
		holderId: requireHolderId(body.holderId),
		model: { provider, id: modelId, ...(thinkingLevel ? { thinkingLevel } : {}) },
	};
}

async function readSessionThinkingRequest(
	request: Request,
): Promise<{ holderId: string; thinkingLevel: StudioThinkingLevel | undefined }> {
	const body = await readJsonRecord(request, "Studio Thinking changes require a JSON request body.");
	const thinkingLevel = body.thinkingLevel;
	if (thinkingLevel !== undefined && !isStudioThinkingLevel(thinkingLevel)) {
		throw new StudioRequestError("invalid_session_request", "Studio session thinking level is invalid.");
	}
	return { holderId: requireHolderId(body.holderId), thinkingLevel };
}

async function readRunCancelRequest(request: Request): Promise<StudioRunCancelRequest> {
	const body = await readJsonRecord(request, "Studio run cancellation requires a JSON request body.");
	return { holderId: requireHolderId(body.holderId) };
}

async function readApprovalResolutionRequest(request: Request): Promise<StudioApprovalResolutionRequest> {
	const body = await readJsonRecord(request, "Studio approval decisions require a JSON request body.");
	if (body.decision !== "approve" && body.decision !== "reject") {
		throw new StudioRequestError("invalid_approval_decision", "Studio approval decision must be approve or reject.");
	}
	return { holderId: requireHolderId(body.holderId), decision: body.decision };
}

async function readWorkspaceRegistrationRequest(request: Request): Promise<{ path: string; label?: string }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new WorkspaceRegistrationError("Workspace registration requires a JSON request body.");
	}
	if (!isRecord(body) || typeof body.path !== "string") {
		throw new WorkspaceRegistrationError("Workspace registration requires a string path.");
	}
	if (body.label !== undefined && typeof body.label !== "string") {
		throw new WorkspaceRegistrationError("Workspace label must be a string.");
	}
	return { path: body.path, label: body.label };
}

function parseWorkspaceId(pathname: string): string | null {
	const match = /^\/api\/v1\/workspaces\/([^/]+)$/.exec(pathname);
	if (!match) return null;
	try {
		const workspaceId = decodeURIComponent(match[1]);
		return /^wsp_[a-f0-9]{32}$/.test(workspaceId) ? workspaceId : null;
	} catch {
		return null;
	}
}

function decodePathId(pathname: string, expression: RegExp, pattern: RegExp): string | null {
	const match = expression.exec(pathname);
	if (!match) return null;
	try {
		const id = decodeURIComponent(match[1]);
		return pattern.test(id) ? id : null;
	} catch {
		return null;
	}
}

function parseStudioSessionId(pathname: string): string | null {
	return decodePathId(pathname, /^\/api\/v1\/sessions\/([^/]+)$/, /^sts_[a-f0-9]{32}$/);
}

function parseStudioSessionActionId(
	pathname: string,
	action:
		| "connect"
		| "mode"
		| "model"
		| "thinking"
		| "lease"
		| "prompts"
		| "approvals"
		| "subagents"
		| "transcript"
		| "activity"
		| "tools"
		| "plan"
		| "changes"
		| "runs"
		| "usage-history",
): string | null {
	return decodePathId(pathname, new RegExp(`^/api/v1/sessions/([^/]+)/${action}$`), /^sts_[a-f0-9]{32}$/);
}

function parseStudioRunCancelId(pathname: string): string | null {
	return decodePathId(pathname, /^\/api\/v1\/runs\/([^/]+)\/cancel$/, /^run_[a-f0-9]{32}$/);
}

function parseStudioApprovalId(pathname: string): string | null {
	return decodePathId(pathname, /^\/api\/v1\/approvals\/([^/]+)$/, /^apr_[a-f0-9]{32}$/);
}

function readOptionalQueryValue(url: URL, name: string): string | undefined {
	const values = url.searchParams.getAll(name);
	if (values.length > 1) {
		throw new StudioRequestError("invalid_query", `Studio query parameter ${name} may only be supplied once.`);
	}
	return values[0];
}

function readOptionalPositiveInteger(url: URL, name: string, maximum: number): number | undefined {
	const value = readOptionalQueryValue(url, name);
	if (value === undefined) return undefined;
	if (!/^[1-9][0-9]*$/.test(value)) {
		throw new StudioRequestError("invalid_query", `Studio query parameter ${name} must be a positive integer.`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new StudioRequestError("invalid_query", `Studio query parameter ${name} is out of range.`);
	}
	return parsed;
}

function readEventCursor(url: URL): number | undefined {
	const value = readOptionalQueryValue(url, "after");
	if (value === undefined) return undefined;
	if (!/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new StudioRequestError("invalid_event_cursor", "Studio event cursor must be a non-negative integer.");
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new StudioRequestError("invalid_event_cursor", "Studio event cursor is out of range.");
	}
	return parsed;
}

function readAuditQuery(url: URL): { beforeId?: number; limit?: number; studioSessionId?: string } {
	const sessionId = readOptionalQueryValue(url, "sessionId");
	if (sessionId !== undefined && !/^sts_[a-f0-9]{32}$/.test(sessionId)) {
		throw new StudioRequestError("invalid_query", "Studio query parameter sessionId is invalid.");
	}
	const beforeId = readOptionalPositiveInteger(url, "before", Number.MAX_SAFE_INTEGER);
	const limit = readOptionalPositiveInteger(url, "limit", 100);
	return {
		...(beforeId === undefined ? {} : { beforeId }),
		...(limit === undefined ? {} : { limit }),
		...(sessionId === undefined ? {} : { studioSessionId: sessionId }),
	};
}

function readTranscriptQuery(url: URL): ListStudioTranscriptMessagesInput {
	const beforeOrdinal = readOptionalPositiveInteger(url, "before", Number.MAX_SAFE_INTEGER);
	const limit = readOptionalPositiveInteger(url, "limit", MAX_STUDIO_TRANSCRIPT_PAGE_SIZE);
	return {
		...(beforeOrdinal === undefined ? {} : { beforeOrdinal }),
		...(limit === undefined ? {} : { limit }),
	};
}

function parseProviderLoginId(pathname: string): string | null {
	const match = /^\/api\/v1\/providers\/([^/]+)\/login$/.exec(pathname);
	if (!match) return null;
	try {
		const providerId = decodeURIComponent(match[1]);
		return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(providerId) ? providerId : null;
	} catch {
		return null;
	}
}

async function readAuthContinuationRequest(request: Request): Promise<{ flowId: string; value: string }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new StudioAuthBridgeError(
			"invalid_auth_continuation",
			"Authentication continuation requires a JSON request body.",
		);
	}
	if (!isRecord(body) || typeof body.flowId !== "string" || typeof body.value !== "string") {
		throw new StudioAuthBridgeError(
			"invalid_auth_continuation",
			"Authentication continuation requires string flowId and value fields.",
		);
	}
	return { flowId: body.flowId, value: body.value };
}

async function readAuthCancellationRequest(request: Request): Promise<{ flowId: string }> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new StudioAuthBridgeError(
			"invalid_auth_cancellation",
			"Authentication cancellation requires a JSON request body.",
		);
	}
	if (!isRecord(body) || typeof body.flowId !== "string") {
		throw new StudioAuthBridgeError(
			"invalid_auth_cancellation",
			"Authentication cancellation requires a string flowId field.",
		);
	}
	return { flowId: body.flowId };
}

function authErrorResponse(error: StudioAuthBridgeError): Response {
	const status =
		error.code === "auth_bridge_unavailable"
			? 503
			: error.code === "provider_not_found" || error.code === "auth_flow_not_found"
				? 404
				: error.code === "auth_flow_active" || error.code === "auth_flow_not_waiting"
					? 409
					: 400;
	return errorResponse(status, error.code, error.message);
}

async function handleProviders(request: Request, runtime: StudioRuntime): Promise<Response> {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio providers support GET requests.");
	}
	try {
		const body: StudioProviderListResponse = { providers: await runtime.auth.listProviders() };
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioAuthBridgeError) return authErrorResponse(error);
		throw error;
	}
}

async function handleProviderLogin(request: Request, providerId: string, runtime: StudioRuntime): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio provider login requires a POST request.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const body: StudioProviderLoginResponse = await runtime.auth.start(providerId);
		return jsonResponse(body, 202);
	} catch (error) {
		if (error instanceof StudioAuthBridgeError) return authErrorResponse(error);
		throw error;
	}
}

async function handleAuthContinue(request: Request, runtime: StudioRuntime): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio authentication continuation requires a POST request.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const continuation = await readAuthContinuationRequest(request);
		runtime.auth.continue(continuation.flowId, continuation.value);
		const body: StudioAuthContinueResponse = { flowId: continuation.flowId, accepted: true };
		return jsonResponse(body, 202);
	} catch (error) {
		if (error instanceof StudioAuthBridgeError) return authErrorResponse(error);
		throw error;
	}
}

async function handleAuthCancel(request: Request, runtime: StudioRuntime): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio authentication cancellation requires a POST request.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const cancellation = await readAuthCancellationRequest(request);
		runtime.auth.cancel(cancellation.flowId);
		const body: StudioAuthCancelResponse = { flowId: cancellation.flowId, cancelled: true };
		return jsonResponse(body, 202);
	} catch (error) {
		if (error instanceof StudioAuthBridgeError) return authErrorResponse(error);
		throw error;
	}
}

async function handleWorkspaceCollection(request: Request, runtime: StudioRuntime): Promise<Response> {
	if (request.method === "GET") {
		const body: StudioWorkspaceListResponse = { workspaces: runtime.store.listWorkspaces() };
		return jsonResponse(body);
	}
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio workspaces support GET and POST requests.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}

	try {
		const requestBody = await readWorkspaceRegistrationRequest(request);
		const registration = await resolveWorkspaceRegistration(requestBody.path, requestBody.label);
		const result = runtime.store.registerWorkspace(registration);
		const body: StudioWorkspaceResponse = { workspace: result.workspace };
		return jsonResponse(body, result.created ? 201 : 200);
	} catch (error) {
		if (error instanceof WorkspaceRegistrationError) {
			return errorResponse(400, "invalid_workspace_path", error.message);
		}
		throw error;
	}
}

async function handleWorkspaceItem(request: Request, workspaceId: string, runtime: StudioRuntime): Promise<Response> {
	if (request.method !== "DELETE") {
		return errorResponse(405, "method_not_allowed", "Studio workspaces support DELETE requests at this path.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	let result: "removed" | "not_found" | "active_run";
	try {
		result = await runtime.supervisor.removeWorkspace(workspaceId);
	} catch (error) {
		logger.warn("Studio could not stop a session during workspace removal", {
			workspaceId,
			error: error instanceof Error ? error.message : String(error),
		});
		return errorResponse(502, "workspace_remove_failed", "OMP Studio could not remove this project. Try again.");
	}
	if (result === "not_found") {
		return errorResponse(404, "workspace_not_found", "The requested workspace is not registered.");
	}
	if (result === "active_run") {
		return errorResponse(409, "workspace_run_active", "Stop the active OMP run before removing this project.");
	}
	return studioResponse(new Response(null, { status: 204 }));
}

function handleAuditCollection(request: Request, url: URL, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio audit records support GET requests.");
	}
	try {
		const body: StudioAuditListResponse = runtime.store.listStudioAuditEntries(readAuditQuery(url));
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		throw error;
	}
}

function requestErrorResponse(error: StudioRequestError): Response {
	return errorResponse(400, error.code, error.message);
}

function supervisorErrorResponse(error: StudioRpcSupervisorError): Response {
	const status =
		error.code === "rpc_supervisor_unavailable"
			? 503
			: error.code === "studio_session_not_found" ||
					error.code === "studio_workspace_not_found" ||
					error.code === "run_not_found" ||
					error.code === "approval_not_found"
				? 404
				: error.code === "run_active" ||
						error.code === "studio_session_removing" ||
						error.code === "run_not_active" ||
						error.code === "studio_session_model_missing" ||
						error.code === "approval_not_active" ||
						error.code === "approval_expired"
					? 409
					: 502;
	return errorResponse(status, error.code, error.message);
}

function requireControlLease(runtime: StudioRuntime, studioSessionId: string, holderId: string): Response | null {
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	if (!runtime.store.hasControlLease(studioSessionId, holderId)) {
		return errorResponse(
			409,
			"control_lease_required",
			"This browser tab does not hold the active control lease for the Studio session.",
		);
	}
	return null;
}

async function handleSessionCollection(request: Request, runtime: StudioRuntime): Promise<Response> {
	if (request.method === "GET") {
		const body: StudioSessionListResponse = { sessions: runtime.store.listStudioSessions() };
		return jsonResponse(body);
	}
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio sessions support GET and POST requests.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	if (!runtime.supervisor.enabled) {
		return errorResponse(
			503,
			"rpc_supervisor_unavailable",
			"OMP RPC supervision is unavailable in this Studio host.",
		);
	}

	try {
		const requestBody = await readSessionCreateRequest(request);
		if (!runtime.store.getWorkspaceCanonicalPath(requestBody.workspaceId)) {
			return errorResponse(404, "workspace_not_found", "The requested workspace is not registered.");
		}
		if (runtime.auth.enabled) {
			const provider = (await runtime.auth.listProviders()).find(candidate => candidate.id === requestBody.provider);
			const model = provider?.models.find(candidate => candidate.id === requestBody.modelId);
			if (!model) {
				return errorResponse(
					400,
					"model_not_available",
					"Choose a model that is available through the selected provider.",
				);
			}
			if (requestBody.thinkingLevel && !model.thinkingLevels?.includes(requestBody.thinkingLevel)) {
				return errorResponse(
					400,
					"thinking_not_supported",
					"The selected model does not support that thinking level.",
				);
			}
		}
		const created = runtime.store.createStudioSession({
			profile: runtime.profile,
			workspaceId: requestBody.workspaceId,
			model: {
				provider: requestBody.provider,
				id: requestBody.modelId,
				...(requestBody.thinkingLevel ? { thinkingLevel: requestBody.thinkingLevel } : {}),
			},
			mode: requestBody.mode ?? "code",
			...(requestBody.name ? { name: requestBody.name } : {}),
		});
		runtime.store.acquireControlLease(created.id, requestBody.holderId, STUDIO_CONTROL_LEASE_DEFAULT_TTL_MS);
		runtime.store.appendAuditEntry({
			action: "session_created",
			studioSessionId: created.id,
			detail: { modelId: requestBody.modelId, provider: requestBody.provider },
		});
		const body: StudioSessionResponse = { session: created };
		return jsonResponse(body, 201);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

function handleSessionItem(request: Request, studioSessionId: string, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio sessions support GET requests at this path.");
	}
	const session = runtime.store.getStudioSession(studioSessionId);
	if (!session) return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	const body: StudioSessionResponse = { session };
	return jsonResponse(body);
}

async function handleSessionConnect(
	request: Request,
	studioSessionId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio session connection requires a POST request.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const session = await runtime.supervisor.startSession(studioSessionId);
		const body: StudioSessionResponse = { session };
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

async function handleSessionMode(request: Request, studioSessionId: string, runtime: StudioRuntime): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio session mode changes require POST requests.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const requestBody = await readSessionModeRequest(request);
		const leaseError = requireControlLease(runtime, studioSessionId, requestBody.holderId);
		if (leaseError) return leaseError;
		const session = await runtime.supervisor.setSessionMode(studioSessionId, requestBody.mode);
		const body: StudioSessionResponse = { session };
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

async function handleSessionModel(
	request: Request,
	studioSessionId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "POST")
		return errorResponse(405, "method_not_allowed", "Studio model changes require POST requests.");
	if (!hasAllowedOrigin(request, runtime.origin))
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	try {
		const requestBody = await readSessionModelRequest(request);
		const leaseError = requireControlLease(runtime, studioSessionId, requestBody.holderId);
		if (leaseError) return leaseError;
		if (runtime.auth.enabled) {
			const provider = (await runtime.auth.listProviders()).find(
				candidate => candidate.id === requestBody.model.provider,
			);
			const model = provider?.models.find(candidate => candidate.id === requestBody.model.id);
			if (!model)
				return errorResponse(
					400,
					"model_not_available",
					"Choose a model that is available through the selected provider.",
				);
			if (requestBody.model.thinkingLevel && !model.thinkingLevels?.includes(requestBody.model.thinkingLevel)) {
				return errorResponse(
					400,
					"thinking_not_supported",
					"The selected model does not support that thinking level.",
				);
			}
		}
		const session = await runtime.supervisor.setSessionModel(studioSessionId, requestBody.model);
		return jsonResponse({ session } satisfies StudioSessionResponse);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

async function handleSessionThinking(
	request: Request,
	studioSessionId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "POST")
		return errorResponse(405, "method_not_allowed", "Studio Thinking changes require POST requests.");
	if (!hasAllowedOrigin(request, runtime.origin))
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	try {
		const requestBody = await readSessionThinkingRequest(request);
		const leaseError = requireControlLease(runtime, studioSessionId, requestBody.holderId);
		if (leaseError) return leaseError;
		const session = await runtime.supervisor.setSessionThinkingLevel(studioSessionId, requestBody.thinkingLevel);
		return jsonResponse({ session } satisfies StudioSessionResponse);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

async function handleSessionApprovals(
	request: Request,
	studioSessionId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session approvals support GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	await runtime.supervisor.reconcileExpiredApprovals(studioSessionId);
	const body: StudioApprovalListResponse = { approvals: runtime.store.listStudioApprovals(studioSessionId) };
	return jsonResponse(body);
}

function handleSessionSubagents(request: Request, studioSessionId: string, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session subagents support GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	const body: StudioSubagentListResponse = { subagents: runtime.supervisor.getSubagents(studioSessionId) };
	return jsonResponse(body);
}

function handleSessionTranscript(
	request: Request,
	url: URL,
	studioSessionId: string,
	runtime: StudioRuntime,
): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session transcripts support GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	try {
		const page = runtime.store.listStudioTranscriptMessages(studioSessionId, readTranscriptQuery(url));
		const body: StudioTranscriptResponse = page;
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		throw error;
	}
}

function handleSessionActivity(request: Request, studioSessionId: string, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session activity supports GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	const body: StudioActivityListResponse = {
		entries: runtime.store.listStudioActivityEntries(studioSessionId),
	};
	return jsonResponse(body);
}

function handleSessionRunHistory(request: Request, studioSessionId: string, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session run history supports GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	const body: StudioRunHistoryResponse = { runs: runtime.store.listStudioRuns(studioSessionId) };
	return jsonResponse(body);
}

function handleSessionUsageHistory(request: Request, studioSessionId: string, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session usage history supports GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	const body: StudioUsageHistoryResponse = { entries: runtime.store.listStudioUsageHistory(studioSessionId) };
	return jsonResponse(body);
}

function handleSessionToolDisplays(request: Request, studioSessionId: string, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session tool cards support GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	const body: StudioToolDisplayListResponse = {
		cards: runtime.store.listStudioToolDisplays(studioSessionId),
	};
	return jsonResponse(body);
}

function handleSessionPlanSummary(request: Request, studioSessionId: string, runtime: StudioRuntime): Response {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session plan summaries support GET requests.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	const plan = runtime.store.getStudioPlanSummary(studioSessionId);
	const body: StudioPlanSummaryResponse = plan ? { plan } : {};
	return jsonResponse(body);
}

async function handleSessionChanges(
	request: Request,
	studioSessionId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "GET") {
		return errorResponse(405, "method_not_allowed", "Studio session changes support GET requests.");
	}
	const session = runtime.store.getStudioSession(studioSessionId);
	if (!session) return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	const adapter = runtime.changeReviewAdapter;
	if (!adapter) {
		return errorResponse(501, "change_review_unavailable", "Change review is unavailable in this Studio host.");
	}
	const workspacePath = runtime.store.getWorkspaceCanonicalPath(session.workspaceId);
	if (!workspacePath) {
		return errorResponse(404, "studio_workspace_not_found", "The requested Studio workspace was not found.");
	}
	try {
		const body: StudioChangeSetResponse = {
			changeSet: await adapter.getChangeSet({
				signal: AbortSignal.timeout(STUDIO_CHANGE_REVIEW_TIMEOUT_MS),
				workspacePath,
			}),
		};
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioChangeReviewError && error.code === "not_repository") {
			return errorResponse(409, "change_review_not_repository", "The registered project is not a Git repository.");
		}
		logger.warn("Studio could not load a workspace change set", { studioSessionId });
		return errorResponse(503, "change_review_unavailable", "Studio could not load this project's change set.");
	}
}

async function handleSessionLease(
	request: Request,
	studioSessionId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "POST" && request.method !== "DELETE") {
		return errorResponse(405, "method_not_allowed", "Studio control leases support POST and DELETE requests.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	if (!runtime.store.getStudioSession(studioSessionId)) {
		return errorResponse(404, "studio_session_not_found", "The requested Studio session was not found.");
	}
	try {
		const requestBody = await readControlLeaseRequest(request);
		if (request.method === "DELETE") {
			if (!runtime.store.releaseControlLease(studioSessionId, requestBody.holderId)) {
				return errorResponse(
					409,
					"control_lease_required",
					"This browser tab does not hold the active control lease for the Studio session.",
				);
			}
			runtime.store.appendAuditEntry({ action: "control_lease_released", studioSessionId, detail: {} });
			return studioResponse(new Response(null, { status: 204 }));
		}

		const result = runtime.store.acquireControlLease(
			studioSessionId,
			requestBody.holderId,
			requestBody.ttlMs ?? STUDIO_CONTROL_LEASE_DEFAULT_TTL_MS,
		);
		if (result.kind === "held") {
			return errorResponse(409, "control_lease_held", "Another local Studio tab currently controls this session.");
		}
		runtime.store.appendAuditEntry({ action: "control_lease_acquired", studioSessionId, detail: {} });
		const body: StudioControlLeaseResponse = {
			lease: { expiresAtMs: result.lease.expiresAtMs, heldByRequester: true },
		};
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		throw error;
	}
}

async function handleSessionPrompt(
	request: Request,
	studioSessionId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio prompts require POST requests.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const requestBody = await readPromptRequest(request);
		const leaseError = requireControlLease(runtime, studioSessionId, requestBody.holderId);
		if (leaseError) return leaseError;
		if (requestBody.images?.length && runtime.auth.enabled) {
			const session = runtime.store.getStudioSession(studioSessionId);
			const model = session?.model;
			const provider = model
				? (await runtime.auth.listProviders()).find(candidate => candidate.id === model.provider)
				: undefined;
			const selectedModel = provider?.models.find(candidate => candidate.id === model?.id);
			if (!selectedModel?.supportsImageInput) {
				return errorResponse(400, "image_input_not_supported", "The selected model does not support image input.");
			}
		}
		const result = await runtime.supervisor.prompt(studioSessionId, requestBody.message, requestBody.images);
		const body: StudioPromptResponse = result;
		return jsonResponse(body, 202);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

async function handleRunCancel(request: Request, runId: string, runtime: StudioRuntime): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio run cancellation requires POST requests.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const requestBody = await readRunCancelRequest(request);
		const run = runtime.store.getStudioRun(runId);
		if (!run) return errorResponse(404, "run_not_found", "The requested Studio run was not found.");
		const leaseError = requireControlLease(runtime, run.studioSessionId, requestBody.holderId);
		if (leaseError) return leaseError;
		const cancelled = await runtime.supervisor.cancelRun(runId);
		const body: StudioRunResponse = { run: cancelled };
		return jsonResponse(body, 202);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

async function handleApprovalResolution(
	request: Request,
	approvalId: string,
	runtime: StudioRuntime,
): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, "method_not_allowed", "Studio approval decisions require POST requests.");
	}
	if (!hasAllowedOrigin(request, runtime.origin)) {
		return errorResponse(403, "origin_not_allowed", "The Studio request origin is not allowed.");
	}
	try {
		const requestBody = await readApprovalResolutionRequest(request);
		const approval = runtime.store.getStudioApproval(approvalId);
		if (!approval) return errorResponse(404, "approval_not_found", "The requested Studio approval was not found.");
		const leaseError = requireControlLease(runtime, approval.studioSessionId, requestBody.holderId);
		if (leaseError) return leaseError;
		const resolved = await runtime.supervisor.resolveApproval(approvalId, requestBody.decision === "approve");
		const body: StudioApprovalResponse = { approval: resolved };
		return jsonResponse(body);
	} catch (error) {
		if (error instanceof StudioRequestError) return requestErrorResponse(error);
		if (error instanceof StudioRpcSupervisorError) return supervisorErrorResponse(error);
		throw error;
	}
}

interface StudioEventContext {
	runId?: string;
	studioSessionId?: string;
}

function createEvent<TData>(
	runtime: StudioRuntime,
	type: StudioEventType,
	data: TData,
	context: StudioEventContext = {},
): StudioEventEnvelope<TData> {
	runtime.nextSequence += 1;
	return {
		version: STUDIO_API_VERSION,
		sequence: runtime.nextSequence,
		type,
		emittedAtMs: Date.now(),
		...context,
		data,
	};
}

function createConnectionEvent<TData>(
	runtime: StudioRuntime,
	type: StudioEventType,
	data: TData,
): StudioEventEnvelope<TData> {
	return {
		version: STUDIO_API_VERSION,
		sequence: runtime.nextSequence,
		type,
		emittedAtMs: Date.now(),
		data,
	};
}

function sendEvent(socket: StudioEventSocket, event: StudioEventEnvelope<unknown>): void {
	try {
		socket.send(JSON.stringify(event));
	} catch {
		// Bun closes stale sockets asynchronously; the close hook removes them.
	}
}

function getEventReplay(
	runtime: StudioRuntime,
	afterSequence: number,
): { events: StudioEventEnvelope<unknown>[] } | { resync: StudioEventResyncRequired } {
	const earliestAvailableSequence = runtime.eventHistory[0]?.sequence;
	if (
		afterSequence > runtime.nextSequence ||
		(afterSequence < runtime.nextSequence &&
			(earliestAvailableSequence === undefined || afterSequence < earliestAvailableSequence - 1))
	) {
		return {
			resync: {
				afterSequence,
				...(earliestAvailableSequence === undefined ? {} : { earliestAvailableSequence }),
				latestSequence: runtime.nextSequence,
			},
		};
	}
	return { events: runtime.eventHistory.filter(event => event.sequence > afterSequence) };
}

function sendConnectionEvents(
	socket: StudioEventSocket,
	runtime: StudioRuntime,
	afterSequence: number | undefined,
): void {
	sendEvent(
		socket,
		createConnectionEvent(
			runtime,
			"studio.ready",
			getBootstrap(
				runtime.profile,
				runtime.auth.enabled,
				runtime.supervisor.enabled,
				runtime.changeReviewAdapter !== undefined,
			),
		),
	);
	if (afterSequence === undefined) return;
	const replay = getEventReplay(runtime, afterSequence);
	if ("resync" in replay) {
		sendEvent(socket, createConnectionEvent(runtime, "studio.resync_required", replay.resync));
		return;
	}
	for (const event of replay.events) sendEvent(socket, event);
}

function broadcastEvent<TData>(
	runtime: StudioRuntime,
	type: StudioEventType,
	data: TData,
	context?: StudioEventContext,
): void {
	const event = createEvent(runtime, type, data, context);
	runtime.eventHistory.push(event);
	if (runtime.eventHistory.length > STUDIO_EVENT_REPLAY_LIMIT) runtime.eventHistory.shift();
	for (const socket of runtime.sockets) sendEvent(socket, event);
}

async function getEmbeddedClientDir(): Promise<string> {
	if (!USE_EMBEDDED_CLIENT) return STUDIO_CLIENT_DIST_DIR;
	if (embeddedClientDirPromise) return embeddedClientDirPromise;
	if (!EMBEDDED_CLIENT_ARCHIVE) {
		throw new Error(
			"Embedded Studio client bundle missing. Rebuild the OMP binary or npm bundle with Studio assets.",
		);
	}

	embeddedClientDirPromise = (async () => {
		const bundleHash = Bun.hash(EMBEDDED_CLIENT_ARCHIVE).toString(16);
		const outputDir = path.join(EMBEDDED_CLIENT_DIR_ROOT, bundleHash);
		const indexPath = path.join(outputDir, "index.html");
		try {
			if ((await fs.stat(indexPath)).isFile()) return outputDir;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		await extractEmbeddedArchive(EMBEDDED_CLIENT_ARCHIVE, outputDir);
		return outputDir;
	})();

	return embeddedClientDirPromise;
}

async function ensureClientReady(): Promise<void> {
	if (!USE_EMBEDDED_CLIENT) await ensureStudioClientBuild();
}

function resolveStaticPath(staticDir: string, requestPath: string): string | null {
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(requestPath);
	} catch {
		return null;
	}
	const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
	if (!relativePath || relativePath.includes("\0")) return null;
	const root = path.resolve(staticDir);
	const candidate = path.resolve(root, relativePath);
	const relative = path.relative(root, candidate);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return null;
	}
	return candidate;
}

async function readStaticFile(filePath: string): Promise<Response | null> {
	try {
		const stats = await fs.stat(filePath);
		if (!stats.isFile()) return null;
		return new Response(Bun.file(filePath));
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function handleStatic(requestPath: string): Promise<Response> {
	const staticDir = await getEmbeddedClientDir();
	const requestedPath = resolveStaticPath(staticDir, requestPath);
	if (!requestedPath) return new Response("Not Found", { status: 404 });
	const requestedFile = await readStaticFile(requestedPath);
	if (requestedFile) return requestedFile;

	if (path.extname(requestPath)) return new Response("Not Found", { status: 404 });
	const indexPath = resolveStaticPath(staticDir, "/");
	if (!indexPath) return new Response("Not Found", { status: 404 });
	return (await readStaticFile(indexPath)) ?? new Response("Not Found", { status: 404 });
}

function formatCookie(token: string): string {
	return `${STUDIO_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

function exchangeAccessToken(request: Request, url: URL, runtime: StudioRuntime): Response | null {
	if (url.pathname !== "/" || !url.searchParams.has("token")) return null;
	if (
		request.method !== "GET" ||
		runtime.localUrlTokenConsumed ||
		url.searchParams.get("token") !== runtime.localUrlToken
	) {
		return errorResponse(401, "invalid_local_token", "The local Studio access token is invalid or has expired.");
	}
	runtime.localUrlTokenConsumed = true;
	return studioResponse(
		new Response(null, {
			status: 302,
			headers: {
				Location: "/",
				"Set-Cookie": formatCookie(runtime.sessionToken),
			},
		}),
	);
}

function assertPort(port: number): void {
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Studio port must be an integer from 0 to 65535, received ${port}.`);
	}
}

/** Format a loopback Studio origin. */
export function formatStudioOrigin(port: number): string {
	return `http://${STUDIO_HOSTNAME}:${port}`;
}

/** Format the one-time URL handed from the Studio CLI command to the local browser. */
export function formatStudioUrl(port: number, accessToken: string): string {
	return `${formatStudioOrigin(port)}/?token=${encodeURIComponent(accessToken)}`;
}

function formatStudioEventsUrl(origin: string): string {
	return `${origin.replace(/^http:/, "ws:")}/api/v1/events`;
}

async function receiveStudioReadyEvent(origin: string, cookie: string): Promise<StudioEventEnvelope<StudioBootstrap>> {
	const socket = new BunWebSocket(formatStudioEventsUrl(origin), {
		headers: { Cookie: cookie, Origin: origin },
	});
	const { promise, resolve, reject } = Promise.withResolvers<StudioEventEnvelope<StudioBootstrap>>();
	let timeout: Timer | undefined;
	const cleanup = (): void => {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		if (timeout !== undefined) clearTimeout(timeout);
		if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000);
	};
	const onMessage = (event: MessageEvent): void => {
		try {
			const data: unknown = JSON.parse(String(event.data));
			if (!data || typeof data !== "object") throw new Error("Studio event was not an object");
			const envelope = data as StudioEventEnvelope<StudioBootstrap>;
			if (envelope.type !== "studio.ready") throw new Error(`Unexpected Studio event: ${envelope.type}`);
			cleanup();
			resolve(envelope);
		} catch (error) {
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	};
	const onError = (): void => {
		cleanup();
		reject(new Error("Studio event smoke failed: WebSocket connection error"));
	};
	timeout = setTimeout(() => {
		cleanup();
		reject(new Error("Studio event smoke failed: timed out waiting for studio.ready"));
	}, STUDIO_EVENT_TIMEOUT_MS);
	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	return promise;
}

/** Start the loopback-only Studio server and its injected OMP RPC control plane. */
export async function startStudioServer(options: StudioServerOptions = {}): Promise<StudioServer> {
	const requestedPort = options.port ?? STUDIO_DEFAULT_PORT;
	assertPort(requestedPort);
	await ensureClientReady();
	const store = await StudioStore.open({ dbPath: options.dbPath });
	store.interruptActiveRuntime("studio_restart");
	let publishAuthProgress: (progress: StudioAuthProgress) => void = () => {};
	const auth = new StudioAuthFlowCoordinator(options.authBridge, progress => publishAuthProgress(progress));
	let runtime: StudioRuntime;
	const supervisorEvents: StudioRpcSupervisorEvents = {
		onActivityUpdated: (studioSessionId, entry) => {
			broadcastEvent(runtime, "activity.updated", entry, { studioSessionId, runId: entry.runId });
		},
		onAgentEvent: (studioSessionId, runId, event) => {
			broadcastEvent(runtime, "agent.event", event, { studioSessionId, runId });
		},
		onPlanSummaryUpdated: (studioSessionId, plan) => {
			broadcastEvent(runtime, "plan.updated", plan, { studioSessionId, runId: plan.runId });
		},
		onApprovalRequested: (studioSessionId, approval) => {
			broadcastEvent(runtime, "approval.requested", approval, { studioSessionId, runId: approval.runId });
		},
		onApprovalResolved: (studioSessionId, approval) => {
			broadcastEvent(runtime, "approval.resolved", approval, { studioSessionId, runId: approval.runId });
		},
		onRunState: (session, run) => {
			broadcastEvent(runtime, "run.state", run, { studioSessionId: session.id, runId: run.id });
		},
		onSubagentState: (studioSessionId, subagent) => {
			broadcastEvent(runtime, "subagent.state", subagent, { studioSessionId });
		},
		onToolDisplayUpdated: (studioSessionId, display) => {
			broadcastEvent(runtime, "tool.display_updated", display, { studioSessionId, runId: display.runId });
		},
		onTranscriptUpdated: (studioSessionId, message) => {
			broadcastEvent(runtime, "transcript.updated", message, { studioSessionId, runId: message.runId });
		},
		onUsageUpdated: (session, usage) => {
			broadcastEvent(runtime, "usage.updated", usage, { studioSessionId: session.id });
		},
	};
	const supervisor = new StudioRpcSupervisor(store, supervisorEvents, options.rpcTransportFactory);

	runtime = {
		auth,
		changeReviewAdapter: options.changeReviewAdapter,
		eventHistory: [],
		localUrlToken: createAccessToken(),
		localUrlTokenConsumed: false,
		nextSequence: 0,
		origin: "",
		profile: getActiveProfile() ?? "default",
		sessionToken: createAccessToken(),
		sockets: new Set(),
		store,
		supervisor,
	};
	publishAuthProgress = progress => broadcastEvent(runtime, "auth.progress", progress);

	try {
		const server = Bun.serve<StudioWebSocketData>({
			hostname: STUDIO_HOSTNAME,
			port: requestedPort,
			async fetch(request, listener) {
				const url = new URL(request.url);
				try {
					const exchanged = exchangeAccessToken(request, url, runtime);
					if (exchanged) return exchanged;
					if (!hasStudioAccess(request, runtime)) {
						return errorResponse(401, "local_access_required", "Open Studio using its one-time local URL.");
					}

					if (url.pathname === "/api/v1/bootstrap" && request.method === "GET") {
						return jsonResponse(
							getBootstrap(
								runtime.profile,
								runtime.auth.enabled,
								runtime.supervisor.enabled,
								runtime.changeReviewAdapter !== undefined,
							),
						);
					}
					if (url.pathname === "/api/v1/audit") return handleAuditCollection(request, url, runtime);

					if (url.pathname === "/api/v1/providers") return await handleProviders(request, runtime);
					const providerId = parseProviderLoginId(url.pathname);
					if (providerId !== null) return await handleProviderLogin(request, providerId, runtime);
					if (url.pathname === "/api/v1/auth/continue") return await handleAuthContinue(request, runtime);
					if (url.pathname === "/api/v1/auth/cancel") return await handleAuthCancel(request, runtime);

					if (url.pathname === "/api/v1/workspaces") return await handleWorkspaceCollection(request, runtime);
					const workspaceId = parseWorkspaceId(url.pathname);
					if (workspaceId !== null) return await handleWorkspaceItem(request, workspaceId, runtime);

					if (url.pathname === "/api/v1/sessions") return await handleSessionCollection(request, runtime);
					const sessionConnectId = parseStudioSessionActionId(url.pathname, "connect");
					if (sessionConnectId !== null) return await handleSessionConnect(request, sessionConnectId, runtime);
					const sessionModeId = parseStudioSessionActionId(url.pathname, "mode");
					if (sessionModeId !== null) return await handleSessionMode(request, sessionModeId, runtime);
					const sessionModelActionId = parseStudioSessionActionId(url.pathname, "model");
					if (sessionModelActionId !== null)
						return await handleSessionModel(request, sessionModelActionId, runtime);
					const sessionThinkingActionId = parseStudioSessionActionId(url.pathname, "thinking");
					if (sessionThinkingActionId !== null)
						return await handleSessionThinking(request, sessionThinkingActionId, runtime);
					const sessionLeaseId = parseStudioSessionActionId(url.pathname, "lease");
					if (sessionLeaseId !== null) return await handleSessionLease(request, sessionLeaseId, runtime);
					const sessionPromptId = parseStudioSessionActionId(url.pathname, "prompts");
					if (sessionPromptId !== null) return await handleSessionPrompt(request, sessionPromptId, runtime);
					const sessionApprovalId = parseStudioSessionActionId(url.pathname, "approvals");
					if (sessionApprovalId !== null) return await handleSessionApprovals(request, sessionApprovalId, runtime);
					const sessionSubagentId = parseStudioSessionActionId(url.pathname, "subagents");
					if (sessionSubagentId !== null) return handleSessionSubagents(request, sessionSubagentId, runtime);
					const sessionTranscriptId = parseStudioSessionActionId(url.pathname, "transcript");
					if (sessionTranscriptId !== null) {
						return handleSessionTranscript(request, url, sessionTranscriptId, runtime);
					}
					const sessionActivityId = parseStudioSessionActionId(url.pathname, "activity");
					if (sessionActivityId !== null) return handleSessionActivity(request, sessionActivityId, runtime);
					const sessionRunHistoryId = parseStudioSessionActionId(url.pathname, "runs");
					if (sessionRunHistoryId !== null) return handleSessionRunHistory(request, sessionRunHistoryId, runtime);
					const sessionUsageHistoryId = parseStudioSessionActionId(url.pathname, "usage-history");
					if (sessionUsageHistoryId !== null)
						return handleSessionUsageHistory(request, sessionUsageHistoryId, runtime);
					const sessionToolDisplayId = parseStudioSessionActionId(url.pathname, "tools");
					if (sessionToolDisplayId !== null)
						return handleSessionToolDisplays(request, sessionToolDisplayId, runtime);
					const sessionPlanSummaryId = parseStudioSessionActionId(url.pathname, "plan");
					if (sessionPlanSummaryId !== null)
						return handleSessionPlanSummary(request, sessionPlanSummaryId, runtime);
					const sessionChangesId = parseStudioSessionActionId(url.pathname, "changes");
					if (sessionChangesId !== null) return await handleSessionChanges(request, sessionChangesId, runtime);
					const studioSessionId = parseStudioSessionId(url.pathname);
					if (studioSessionId !== null) return handleSessionItem(request, studioSessionId, runtime);
					const runCancelId = parseStudioRunCancelId(url.pathname);
					if (runCancelId !== null) return await handleRunCancel(request, runCancelId, runtime);
					const approvalId = parseStudioApprovalId(url.pathname);
					if (approvalId !== null) return await handleApprovalResolution(request, approvalId, runtime);

					if (url.pathname === "/api/v1/events") {
						if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
							return errorResponse(
								400,
								"websocket_upgrade_required",
								"Studio events require a WebSocket upgrade.",
							);
						}
						if (!hasAllowedOrigin(request, runtime.origin)) {
							return errorResponse(403, "origin_not_allowed", "The Studio event origin is not allowed.");
						}
						let afterSequence: number | undefined;
						try {
							afterSequence = readEventCursor(url);
						} catch (error) {
							if (error instanceof StudioRequestError) return requestErrorResponse(error);
							throw error;
						}
						if (listener.upgrade(request, { data: { afterSequence, connectedAtMs: Date.now() } })) return;
						return errorResponse(
							400,
							"websocket_upgrade_failed",
							"Studio could not upgrade the event connection.",
						);
					}

					if (url.pathname.startsWith("/api/")) {
						return errorResponse(404, "not_found", "The Studio API route was not found.");
					}

					return studioResponse(await handleStatic(url.pathname));
				} catch (error) {
					logger.error("Studio request failed", {
						path: url.pathname,
						error: error instanceof Error ? error.message : String(error),
					});
					return errorResponse(500, "internal_error", "Studio could not complete the request.");
				}
			},
			websocket: {
				open(socket) {
					runtime.sockets.add(socket);
					sendConnectionEvents(socket, runtime, socket.data.afterSequence);
				},
				message(socket) {
					socket.close(1008, "Studio events are read-only.");
				},
				close(socket) {
					runtime.sockets.delete(socket);
				},
			},
		});

		const port = server.port ?? requestedPort;
		runtime.origin = formatStudioOrigin(port);
		let stopped = false;
		return {
			hostname: STUDIO_HOSTNAME,
			port,
			origin: runtime.origin,
			url: formatStudioUrl(port, runtime.localUrlToken),
			stop: () => {
				if (stopped) return;
				stopped = true;
				supervisor.close();
				auth.close();
				// Close active connections rather than draining them. The event
				// WebSocket is open for as long as a tab is, so a drain never
				// finishes: the process would outlive its own shutdown until
				// something killed it.
				server.stop(true);
				store.close();
			},
		};
	} catch (error) {
		supervisor.close();
		auth.close();
		store.close();
		throw error;
	}
}

/** Exercise the access exchange, client asset path, and bootstrap endpoint in source and compiled builds. */
export async function smokeTestStudioServer(): Promise<void> {
	const studio = await startStudioServer({ dbPath: ":memory:", port: 0 });
	try {
		const exchange = await fetch(studio.url, { redirect: "manual" });
		if (exchange.status !== 302) throw new Error(`Studio smoke token exchange failed: HTTP ${exchange.status}`);
		const cookieHeader = exchange.headers.get("set-cookie");
		const cookie = cookieHeader?.split(";", 1)[0];
		if (!cookie) throw new Error("Studio smoke token exchange did not set a session cookie");

		const [clientResponse, bootstrapResponse] = await Promise.all([
			fetch(`${studio.origin}/`, { headers: { Cookie: cookie } }),
			fetch(`${studio.origin}/api/v1/bootstrap`, { headers: { Cookie: cookie } }),
		]);
		if (!clientResponse.ok) throw new Error(`Studio client smoke failed: HTTP ${clientResponse.status}`);
		if (!bootstrapResponse.ok) throw new Error(`Studio bootstrap smoke failed: HTTP ${bootstrapResponse.status}`);
		const clientHtml = await clientResponse.text();
		if (!clientHtml.includes('<div id="root"></div>') || !clientHtml.includes("main.js")) {
			throw new Error("Studio client smoke failed: client shell was not served");
		}
		const bootstrap = (await bootstrapResponse.json()) as StudioBootstrap;
		if (bootstrap.apiVersion !== STUDIO_API_VERSION || bootstrap.mode !== "local-single-user") {
			throw new Error("Studio bootstrap smoke failed: unexpected bootstrap payload");
		}
		const ready = await receiveStudioReadyEvent(studio.origin, cookie);
		if (ready.version !== STUDIO_API_VERSION || ready.data.profile !== bootstrap.profile) {
			throw new Error("Studio event smoke failed: unexpected studio.ready payload");
		}
	} finally {
		studio.stop();
	}
}
