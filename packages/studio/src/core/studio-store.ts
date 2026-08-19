import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getStudioDbPath } from "@oh-my-pi/pi-utils/dirs";
import type {
	StudioActivityEntry,
	StudioActivityStatus,
	StudioActivitySubject,
	StudioApproval,
	StudioApprovalStatus,
	StudioAuditDetail,
	StudioAuditEntry,
	StudioModelSelection,
	StudioPlanSummary,
	StudioRun,
	StudioRunStatus,
	StudioSession,
	StudioSessionStatus,
	StudioToolDisplay,
	StudioToolDisplayKind,
	StudioToolDisplayStatus,
	StudioTranscriptMessage,
	StudioTranscriptMessageStatus,
	StudioUsage,
	StudioUsageHistoryEntry,
	StudioWorkspace,
} from "../protocol";

const STUDIO_SCHEMA_VERSION = 7;
const ACTIVE_RUN_STATUSES = ["starting", "running", "cancelling"] as const;
const MAX_STUDIO_TRANSCRIPT_TEXT_LENGTH = 100_000;
const MAX_STUDIO_ACTIVITY_ENTRIES_PER_SESSION = 500;
const MAX_STUDIO_TOOL_DISPLAYS_PER_SESSION = 200;
const MAX_STUDIO_USAGE_HISTORY_ENTRIES_PER_SESSION = 120;
const MAX_AUDIT_ENTRIES = 2_000;
const MAX_AUDIT_DETAIL_TEXT_LENGTH = 240;
const AUDIT_DETAIL_KEYS = [
	"approvalId",
	"argumentsDigest",
	"modelId",
	"provider",
	"reason",
	"rpcProtocolVersion",
	"toolName",
] as const;
const AUDIT_REASON_VALUES = new Set([
	"approval expired",
	"rpc_agent_failed",
	"rpc_child_exited",
	"rpc_prompt_failed",
	"run_cancel_requested",
	"run_cancelled",
	"run_completed",
	"studio_restart",
	"studio_shutdown",
]);
const STUDIO_ACTIVITY_SUBJECT_VALUES: readonly StudioActivitySubject[] = [
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
];
const STUDIO_ACTIVITY_STATUS_VALUES: readonly StudioActivityStatus[] = ["running", "completed", "failed", "cancelled"];
const STUDIO_TOOL_DISPLAY_KIND_VALUES: readonly StudioToolDisplayKind[] = [
	"command",
	"file_read",
	"file_write",
	"file_search",
	"web",
	"task",
	"tool",
];

const STUDIO_MIGRATIONS = [
	{
		version: 1,
		sql: `
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at_ms INTEGER NOT NULL
			);

			CREATE TABLE studio_settings (
				key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);

			CREATE TABLE workspaces (
				id TEXT PRIMARY KEY,
				canonical_path TEXT NOT NULL UNIQUE,
				label TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);

			CREATE TABLE studio_sessions (
				id TEXT PRIMARY KEY,
				profile TEXT NOT NULL,
				workspace_id TEXT NOT NULL REFERENCES workspaces(id),
				omp_session_id TEXT,
				omp_session_ref TEXT,
				name TEXT,
				model_provider TEXT,
				model_id TEXT,
				status TEXT NOT NULL,
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				last_activity_at_ms INTEGER
			);

			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				studio_session_id TEXT NOT NULL REFERENCES studio_sessions(id),
				status TEXT NOT NULL,
				rpc_protocol_version INTEGER,
				started_at_ms INTEGER NOT NULL,
				ended_at_ms INTEGER,
				interrupted_reason TEXT,
				event_sequence INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE control_leases (
				studio_session_id TEXT PRIMARY KEY REFERENCES studio_sessions(id),
				holder_id TEXT NOT NULL,
				issued_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER NOT NULL
			);

			CREATE TABLE approvals (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL REFERENCES runs(id),
				tool_call_id TEXT NOT NULL,
				arguments_digest TEXT NOT NULL,
				status TEXT NOT NULL,
				requested_at_ms INTEGER NOT NULL,
				expires_at_ms INTEGER NOT NULL,
				resolved_at_ms INTEGER,
				resolution_reason TEXT
			);

			CREATE TABLE audit_log (
				id INTEGER PRIMARY KEY,
				occurred_at_ms INTEGER NOT NULL,
				action TEXT NOT NULL,
				studio_session_id TEXT REFERENCES studio_sessions(id),
				run_id TEXT REFERENCES runs(id),
				detail_json TEXT NOT NULL
			);

			CREATE INDEX workspace_label_idx ON workspaces(label COLLATE NOCASE, id);
			CREATE INDEX studio_sessions_workspace_idx ON studio_sessions(workspace_id, updated_at_ms DESC);
			CREATE INDEX runs_session_status_idx ON runs(studio_session_id, status, started_at_ms DESC);
			CREATE INDEX approvals_run_status_idx ON approvals(run_id, status, expires_at_ms);
		`,
	},
	{
		version: 2,
		sql: `
			ALTER TABLE studio_sessions ADD COLUMN usage_json TEXT;
			ALTER TABLE studio_sessions ADD COLUMN usage_updated_at_ms INTEGER;
			ALTER TABLE approvals ADD COLUMN tool_name TEXT NOT NULL DEFAULT 'tool';
			ALTER TABLE approvals ADD COLUMN reason TEXT;
			CREATE INDEX studio_sessions_usage_idx ON studio_sessions(usage_updated_at_ms DESC);
		`,
	},
	{
		version: 3,
		sql: `
			CREATE INDEX audit_log_session_id_idx ON audit_log(studio_session_id, id DESC);
		`,
	},
	{
		version: 4,
		sql: `
			CREATE TABLE transcript_messages (
				ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				studio_session_id TEXT NOT NULL REFERENCES studio_sessions(id),
				run_id TEXT NOT NULL REFERENCES runs(id),
				source_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
				text TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('streaming', 'completed', 'failed', 'interrupted')),
				created_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				UNIQUE(run_id, source_id)
			);
			CREATE INDEX transcript_messages_session_ordinal_idx ON transcript_messages(studio_session_id, ordinal);
			CREATE INDEX transcript_messages_run_status_idx ON transcript_messages(run_id, status);
		`,
	},
	{
		version: 5,
		sql: `
			CREATE TABLE studio_activity_entries (
				ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				studio_session_id TEXT NOT NULL REFERENCES studio_sessions(id),
				run_id TEXT NOT NULL REFERENCES runs(id),
				subject TEXT NOT NULL CHECK(subject IN (
					'agent', 'command', 'file_read', 'file_write', 'file_search', 'web', 'task', 'context', 'retry', 'tool', 'system'
				)),
				status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
				occurred_at_ms INTEGER NOT NULL
			);
			CREATE INDEX studio_activity_entries_session_ordinal_idx
				ON studio_activity_entries(studio_session_id, ordinal DESC);
			CREATE INDEX studio_activity_entries_run_ordinal_idx
				ON studio_activity_entries(run_id, ordinal DESC);
		`,
	},
	{
		version: 6,
		sql: `
			CREATE TABLE studio_tool_displays (
				ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				studio_session_id TEXT NOT NULL REFERENCES studio_sessions(id),
				run_id TEXT NOT NULL REFERENCES runs(id),
				kind TEXT NOT NULL CHECK(kind IN ('command', 'file_read', 'file_write', 'file_search', 'web', 'task', 'tool')),
				status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
				started_at_ms INTEGER NOT NULL,
				updated_at_ms INTEGER NOT NULL
			);
			CREATE INDEX studio_tool_displays_session_ordinal_idx
				ON studio_tool_displays(studio_session_id, ordinal DESC);
			CREATE INDEX studio_tool_displays_run_status_idx
				ON studio_tool_displays(run_id, status, ordinal DESC);

			CREATE TABLE studio_plan_summaries (
				studio_session_id TEXT PRIMARY KEY REFERENCES studio_sessions(id),
				run_id TEXT NOT NULL REFERENCES runs(id),
				total_task_count INTEGER NOT NULL CHECK(total_task_count >= 0),
				pending_task_count INTEGER NOT NULL CHECK(pending_task_count >= 0),
				in_progress_task_count INTEGER NOT NULL CHECK(in_progress_task_count >= 0),
				completed_task_count INTEGER NOT NULL CHECK(completed_task_count >= 0),
				blocked_task_count INTEGER NOT NULL CHECK(blocked_task_count >= 0),
				abandoned_task_count INTEGER NOT NULL CHECK(abandoned_task_count >= 0),
				updated_at_ms INTEGER NOT NULL
			);
		`,
	},
	{
		version: 7,
		sql: `
			CREATE TABLE studio_usage_history (
				ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				studio_session_id TEXT NOT NULL REFERENCES studio_sessions(id),
				run_id TEXT NOT NULL REFERENCES runs(id),
				usage_json TEXT NOT NULL,
				occurred_at_ms INTEGER NOT NULL,
				UNIQUE(run_id, usage_json)
			);
			CREATE INDEX studio_usage_history_session_ordinal_idx
				ON studio_usage_history(studio_session_id, ordinal DESC);
			CREATE INDEX studio_usage_history_run_ordinal_idx
				ON studio_usage_history(run_id, ordinal DESC);
		`,
	},
] as const;

interface StudioMigrationRow {
	version: number;
}

interface WorkspaceRow {
	id: string;
	label: string;
	created_at_ms: number;
	updated_at_ms: number;
}

interface ExistingWorkspaceRow extends WorkspaceRow {
	canonical_path: string;
}

interface StudioSessionRow {
	id: string;
	profile: string;
	workspace_id: string;
	omp_session_id: string | null;
	omp_session_ref: string | null;
	name: string | null;
	model_provider: string | null;
	model_id: string | null;
	status: StudioSessionStatus;
	created_at_ms: number;
	updated_at_ms: number;
	last_activity_at_ms: number | null;
	usage_json: string | null;
	usage_updated_at_ms: number | null;
}

interface StudioRunRow {
	id: string;
	studio_session_id: string;
	status: StudioRunStatus;
	rpc_protocol_version: number | null;
	started_at_ms: number;
	ended_at_ms: number | null;
	interrupted_reason: string | null;
}

interface LeaseRow {
	studio_session_id: string;
	holder_id: string;
	issued_at_ms: number;
	expires_at_ms: number;
}

interface StudioApprovalRow {
	id: string;
	run_id: string;
	studio_session_id: string;
	tool_call_id: string;
	tool_name: string;
	arguments_digest: string;
	status: StudioApprovalStatus;
	requested_at_ms: number;
	expires_at_ms: number;
	resolved_at_ms: number | null;
	resolution_reason: string | null;
	reason: string | null;
}

interface StudioAuditRow {
	id: number;
	occurred_at_ms: number;
	action: string;
	studio_session_id: string | null;
	run_id: string | null;
	detail_json: string;
}

interface StudioTranscriptMessageRow {
	id: string;
	studio_session_id: string;
	run_id: string;
	role: StudioTranscriptMessage["role"];
	text: string;
	status: StudioTranscriptMessageStatus;
	created_at_ms: number;
	updated_at_ms: number;
}

interface StudioTranscriptTimestampRow {
	latest_created_at_ms: number | null;
}

interface StudioActivityEntryRow {
	id: string;
	studio_session_id: string;
	run_id: string;
	subject: string;
	status: string;
	occurred_at_ms: number;
}

interface StudioToolDisplayRow {
	id: string;
	studio_session_id: string;
	run_id: string;
	kind: string;
	status: string;
	started_at_ms: number;
	updated_at_ms: number;
}

interface StudioPlanSummaryRow {
	studio_session_id: string;
	run_id: string;
	total_task_count: number;
	pending_task_count: number;
	in_progress_task_count: number;
	completed_task_count: number;
	blocked_task_count: number;
	abandoned_task_count: number;
	updated_at_ms: number;
}

interface StudioUsageHistoryRow {
	id: string;
	studio_session_id: string;
	run_id: string;
	usage_json: string;
	occurred_at_ms: number;
}

export interface StudioStoreOptions {
	dbPath?: string;
}

export interface RegisterWorkspaceInput {
	canonicalPath: string;
	label: string;
}

export interface RegisterWorkspaceResult {
	created: boolean;
	workspace: StudioWorkspace;
}

export type RemoveWorkspaceResult = "removed" | "not_found" | "in_use";

export interface StudioControlLease {
	studioSessionId: string;
	holderId: string;
	issuedAtMs: number;
	expiresAtMs: number;
}

export type AcquireControlLeaseResult =
	| { kind: "acquired"; lease: StudioControlLease }
	| { kind: "held"; lease: StudioControlLease };

export interface CreateStudioSessionInput {
	profile: string;
	workspaceId: string;
	name?: string;
	model: StudioModelSelection;
}

export interface StudioStoredSession {
	ompSessionId?: string;
	ompSessionRef?: string;
	session: StudioSession;
}

export interface UpdateStudioSessionRuntimeInput {
	status: StudioSessionStatus;
	ompSessionId?: string;
	ompSessionRef?: string;
}

export type CreateStudioRunResult = { kind: "created"; run: StudioRun } | { kind: "active"; run: StudioRun };

export interface StudioAuditEntryInput {
	action: string;
	studioSessionId?: string;
	runId?: string;
	detail: StudioAuditDetail;
}

export interface ListStudioAuditEntriesInput {
	beforeId?: number;
	limit?: number;
	studioSessionId?: string;
}

export interface ListStudioAuditEntriesResult {
	entries: StudioAuditEntry[];
	nextBeforeId?: number;
}

export interface CreateStudioApprovalInput {
	runId: string;
	toolCallId: string;
	toolName: string;
	argumentsDigest: string;
	reason?: string;
	expiresAtMs: number;
}

export interface CreateStudioUserTranscriptMessageInput {
	studioSessionId: string;
	runId: string;
	text: string;
}

export interface UpsertStudioAssistantTranscriptMessageInput {
	studioSessionId: string;
	runId: string;
	sourceId: string;
	text: string;
	status: Extract<StudioTranscriptMessageStatus, "streaming" | "completed" | "failed">;
}

export interface AppendStudioActivityEntryInput {
	studioSessionId: string;
	runId: string;
	subject: StudioActivitySubject;
	status: StudioActivityStatus;
}

export interface AppendStudioToolDisplayInput {
	studioSessionId: string;
	runId: string;
	kind: StudioToolDisplayKind;
}

export interface UpdateStudioPlanSummaryInput {
	studioSessionId: string;
	runId: string;
	totalTaskCount: number;
	pendingTaskCount: number;
	inProgressTaskCount: number;
	completedTaskCount: number;
	blockedTaskCount: number;
	abandonedTaskCount: number;
}

export interface AppendStudioUsageHistoryInput {
	studioSessionId: string;
	runId: string;
	usage: Omit<StudioUsage, "updatedAtMs">;
}

export type ResolveStudioApprovalResult =
	| { kind: "resolved"; approval: StudioApproval }
	| { kind: "not_found" }
	| { kind: "not_pending"; approval: StudioApproval }
	| { kind: "expired"; approval: StudioApproval };

function toWorkspace(row: WorkspaceRow): StudioWorkspace {
	return {
		id: row.id,
		label: row.label,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

function toLease(row: LeaseRow): StudioControlLease {
	return {
		studioSessionId: row.studio_session_id,
		holderId: row.holder_id,
		issuedAtMs: row.issued_at_ms,
		expiresAtMs: row.expires_at_ms,
	};
}

function toStudioRun(row: StudioRunRow): StudioRun {
	return {
		id: row.id,
		studioSessionId: row.studio_session_id,
		status: row.status,
		...(row.rpc_protocol_version === null ? {} : { rpcProtocolVersion: row.rpc_protocol_version }),
		startedAtMs: row.started_at_ms,
		...(row.ended_at_ms === null ? {} : { endedAtMs: row.ended_at_ms }),
		...(row.interrupted_reason === null || !AUDIT_REASON_VALUES.has(row.interrupted_reason)
			? {}
			: { interruptedReason: row.interrupted_reason }),
	};
}

function toStudioTranscriptMessage(row: StudioTranscriptMessageRow): StudioTranscriptMessage {
	return {
		id: row.id,
		studioSessionId: row.studio_session_id,
		runId: row.run_id,
		role: row.role,
		text: row.text,
		status: row.status,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

function isStudioActivitySubject(value: string): value is StudioActivitySubject {
	return STUDIO_ACTIVITY_SUBJECT_VALUES.includes(value as StudioActivitySubject);
}

function isStudioActivityStatus(value: string): value is StudioActivityStatus {
	return STUDIO_ACTIVITY_STATUS_VALUES.includes(value as StudioActivityStatus);
}

function toStudioActivityEntry(row: StudioActivityEntryRow): StudioActivityEntry | undefined {
	if (!isStudioActivitySubject(row.subject) || !isStudioActivityStatus(row.status)) return undefined;
	if (!Number.isSafeInteger(row.occurred_at_ms) || row.occurred_at_ms < 0) return undefined;
	return {
		id: row.id,
		studioSessionId: row.studio_session_id,
		runId: row.run_id,
		subject: row.subject,
		status: row.status,
		occurredAtMs: row.occurred_at_ms,
	};
}

function isStudioToolDisplayKind(value: string): value is StudioToolDisplayKind {
	return STUDIO_TOOL_DISPLAY_KIND_VALUES.includes(value as StudioToolDisplayKind);
}

function isStudioToolDisplayStatus(value: string): value is StudioToolDisplayStatus {
	return STUDIO_ACTIVITY_STATUS_VALUES.includes(value as StudioToolDisplayStatus);
}

function toStudioToolDisplay(row: StudioToolDisplayRow): StudioToolDisplay | undefined {
	if (!isStudioToolDisplayKind(row.kind) || !isStudioToolDisplayStatus(row.status)) return undefined;
	if (
		!Number.isSafeInteger(row.started_at_ms) ||
		row.started_at_ms < 0 ||
		!Number.isSafeInteger(row.updated_at_ms) ||
		row.updated_at_ms < 0
	) {
		return undefined;
	}
	return {
		id: row.id,
		studioSessionId: row.studio_session_id,
		runId: row.run_id,
		kind: row.kind,
		status: row.status,
		startedAtMs: row.started_at_ms,
		updatedAtMs: row.updated_at_ms,
	};
}

function toStudioPlanSummary(row: StudioPlanSummaryRow): StudioPlanSummary | undefined {
	const counts = [
		row.total_task_count,
		row.pending_task_count,
		row.in_progress_task_count,
		row.completed_task_count,
		row.blocked_task_count,
		row.abandoned_task_count,
	];
	if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined;
	if (!Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0) return undefined;
	return {
		studioSessionId: row.studio_session_id,
		runId: row.run_id,
		totalTaskCount: row.total_task_count,
		pendingTaskCount: row.pending_task_count,
		inProgressTaskCount: row.in_progress_task_count,
		completedTaskCount: row.completed_task_count,
		blockedTaskCount: row.blocked_task_count,
		abandonedTaskCount: row.abandoned_task_count,
		updatedAtMs: row.updated_at_ms,
	};
}

function assertTranscriptText(text: string, allowEmpty = false): void {
	if ((!allowEmpty && !text) || text.length > MAX_STUDIO_TRANSCRIPT_TEXT_LENGTH) {
		throw new Error("Studio transcript text is invalid or exceeds the maximum length.");
	}
}

function assertTranscriptSourceId(sourceId: string): void {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceId)) {
		throw new Error("Studio transcript source ID is invalid.");
	}
}

function numberField(value: Record<string, unknown>, field: string): number | undefined {
	const candidate = value[field];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function toStudioUsageValue(value: unknown, updatedAtMs: number): StudioUsage | undefined {
	if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) return undefined;
	try {
		const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
		if (!isRecord(parsed)) return undefined;
		const inputTokens = numberField(parsed, "inputTokens");
		const outputTokens = numberField(parsed, "outputTokens");
		const reasoningTokens = numberField(parsed, "reasoningTokens");
		const cacheReadTokens = numberField(parsed, "cacheReadTokens");
		const cacheWriteTokens = numberField(parsed, "cacheWriteTokens");
		const totalTokens = numberField(parsed, "totalTokens");
		const premiumRequests = numberField(parsed, "premiumRequests");
		const cost = numberField(parsed, "cost");
		const toolCalls = numberField(parsed, "toolCalls");
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
			return undefined;
		}
		const contextTokens = numberField(parsed, "contextTokens");
		const contextWindow = numberField(parsed, "contextWindow");
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
			updatedAtMs,
		};
	} catch {
		return undefined;
	}
}

function toStudioUsage(row: StudioSessionRow): StudioUsage | undefined {
	if (row.usage_json === null || row.usage_updated_at_ms === null) return undefined;
	return toStudioUsageValue(row.usage_json, row.usage_updated_at_ms);
}

function encodeStudioUsage(usage: Omit<StudioUsage, "updatedAtMs">): string {
	const stored = {
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		cost: usage.cost,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		premiumRequests: usage.premiumRequests,
		reasoningTokens: usage.reasoningTokens,
		totalTokens: usage.totalTokens,
		toolCalls: usage.toolCalls,
		...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
		...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
	};
	if (!toStudioUsageValue(stored, 0)) throw new Error("Studio usage contains invalid values.");
	return JSON.stringify(stored);
}

function toStudioUsageHistoryEntry(row: StudioUsageHistoryRow): StudioUsageHistoryEntry | undefined {
	const usage = toStudioUsageValue(row.usage_json, row.occurred_at_ms);
	if (!usage) return undefined;
	return {
		id: row.id,
		studioSessionId: row.studio_session_id,
		runId: row.run_id,
		usage,
	};
}

function toStudioApproval(row: StudioApprovalRow): StudioApproval {
	return {
		id: row.id,
		runId: row.run_id,
		studioSessionId: row.studio_session_id,
		toolCallId: row.tool_call_id,
		toolName: row.tool_name,
		argumentsDigest: row.arguments_digest,
		status: row.status,
		requestedAtMs: row.requested_at_ms,
		expiresAtMs: row.expires_at_ms,
		...(row.reason === null ? {} : { reason: row.reason }),
		...(row.resolved_at_ms === null ? {} : { resolvedAtMs: row.resolved_at_ms }),
		...(row.resolution_reason === null ? {} : { resolutionReason: row.resolution_reason }),
	};
}

function sanitizeAuditText(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.trim()
		.slice(0, MAX_AUDIT_DETAIL_TEXT_LENGTH);
}

function toStudioAuditDetail(value: unknown): StudioAuditDetail {
	if (!isRecord(value)) return {};
	const detail: StudioAuditDetail = {};
	for (const key of AUDIT_DETAIL_KEYS) {
		const candidate = value[key];
		if (key === "reason") {
			if (typeof candidate === "string" && AUDIT_REASON_VALUES.has(candidate)) detail.reason = candidate;
			continue;
		}
		if (typeof candidate === "string") detail[key] = sanitizeAuditText(candidate);
		else if (typeof candidate === "number" && Number.isFinite(candidate)) detail[key] = candidate;
		else if (typeof candidate === "boolean") detail[key] = candidate;
	}
	return detail;
}

function toStudioAuditEntry(row: StudioAuditRow): StudioAuditEntry {
	let detail: StudioAuditDetail = {};
	try {
		detail = toStudioAuditDetail(JSON.parse(row.detail_json));
	} catch {
		// A malformed local row is omitted rather than being reflected into the browser.
	}
	return {
		id: row.id,
		occurredAtMs: row.occurred_at_ms,
		action: /^[a-z][a-z0-9_]{0,63}$/.test(row.action) ? row.action : "unknown",
		...(row.studio_session_id === null ? {} : { studioSessionId: row.studio_session_id }),
		...(row.run_id === null ? {} : { runId: row.run_id }),
		detail,
	};
}

function toStudioSession(row: StudioSessionRow, activeRun?: StudioRun): StudioSession {
	const model =
		row.model_provider === null || row.model_id === null
			? undefined
			: { provider: row.model_provider, id: row.model_id };
	const usage = toStudioUsage(row);
	return {
		id: row.id,
		profile: row.profile,
		workspaceId: row.workspace_id,
		...(row.name === null ? {} : { name: row.name }),
		...(model ? { model } : {}),
		status: row.status,
		createdAtMs: row.created_at_ms,
		updatedAtMs: row.updated_at_ms,
		...(row.last_activity_at_ms === null ? {} : { lastActivityAtMs: row.last_activity_at_ms }),
		...(activeRun ? { activeRun } : {}),
		...(usage ? { usage } : {}),
	};
}

function runMigrations(db: Database): void {
	let transactionOpen = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		transactionOpen = true;
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at_ms INTEGER NOT NULL
			)
		`);
		const appliedRows = db.query<StudioMigrationRow, []>("SELECT version FROM schema_migrations").all();
		const appliedVersions = new Set(appliedRows.map(row => row.version));
		const highestAppliedVersion = Math.max(0, ...appliedVersions);
		if (highestAppliedVersion > STUDIO_SCHEMA_VERSION) {
			throw new Error(
				`Studio database schema version ${highestAppliedVersion} is newer than this OMP Studio build (${STUDIO_SCHEMA_VERSION}).`,
			);
		}

		const insertMigration = db.query<void, [number, number]>(
			"INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)",
		);
		for (const migration of STUDIO_MIGRATIONS) {
			if (appliedVersions.has(migration.version)) continue;
			db.exec(migration.sql);
			insertMigration.run(migration.version, Date.now());
		}
		db.exec("COMMIT");
	} catch (error) {
		if (transactionOpen) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Preserve the migration error when SQLite has already closed the transaction.
			}
		}
		throw error;
	}
}

/** Persistent local control-plane metadata. It never stores provider credentials in Studio-owned tables. */
export class StudioStore {
	#db: Database;
	#dbPath: string;

	constructor(db: Database, dbPath: string) {
		this.#db = db;
		this.#dbPath = dbPath;
	}

	static async open(options: StudioStoreOptions = {}): Promise<StudioStore> {
		const dbPath = options.dbPath ?? getStudioDbPath();
		if (dbPath !== ":memory:") await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { create: true, strict: true });
		try {
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("PRAGMA foreign_keys = ON");
			if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
			runMigrations(db);
			const store = new StudioStore(db, dbPath);
			store.#pruneAuditEntries();
			return store;
		} catch (error) {
			db.close(true);
			throw error;
		}
	}

	get dbPath(): string {
		return this.#dbPath;
	}

	close(): void {
		this.#db.close();
	}

	listWorkspaces(): StudioWorkspace[] {
		const rows = this.#db
			.query<WorkspaceRow, []>(
				"SELECT id, label, created_at_ms, updated_at_ms FROM workspaces ORDER BY label COLLATE NOCASE, id",
			)
			.all();
		return rows.map(toWorkspace);
	}

	getWorkspaceCanonicalPath(workspaceId: string): string | undefined {
		return this.#db.query<ExistingWorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?").get(workspaceId)
			?.canonical_path;
	}

	registerWorkspace(input: RegisterWorkspaceInput): RegisterWorkspaceResult {
		const existing = this.#db
			.query<ExistingWorkspaceRow, [string]>(
				"SELECT id, canonical_path, label, created_at_ms, updated_at_ms FROM workspaces WHERE canonical_path = ?",
			)
			.get(input.canonicalPath);
		if (existing) return { created: false, workspace: toWorkspace(existing) };

		const now = Date.now();
		const id = `wsp_${crypto.randomUUID().replaceAll("-", "")}`;
		try {
			const row = this.#db
				.query<WorkspaceRow, [string, string, string, number, number]>(
					`INSERT INTO workspaces (id, canonical_path, label, created_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, ?, ?)
					 RETURNING id, label, created_at_ms, updated_at_ms`,
				)
				.get(id, input.canonicalPath, input.label, now, now);
			if (!row) throw new Error("Studio workspace insert did not return a row");
			return { created: true, workspace: toWorkspace(row) };
		} catch (error) {
			const concurrent = this.#db
				.query<ExistingWorkspaceRow, [string]>(
					"SELECT id, canonical_path, label, created_at_ms, updated_at_ms FROM workspaces WHERE canonical_path = ?",
				)
				.get(input.canonicalPath);
			if (concurrent) return { created: false, workspace: toWorkspace(concurrent) };
			throw error;
		}
	}

	removeWorkspace(workspaceId: string): RemoveWorkspaceResult {
		return this.#transaction(() => {
			const existing = this.#db
				.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ?")
				.get(workspaceId);
			if (!existing) return "not_found";
			const linkedSession = this.#db
				.query<{ id: string }, [string]>("SELECT id FROM studio_sessions WHERE workspace_id = ? LIMIT 1")
				.get(workspaceId);
			if (linkedSession) return "in_use";
			this.#db.query<void, [string]>("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
			return "removed";
		});
	}

	createStudioSession(input: CreateStudioSessionInput): StudioSession {
		const now = Date.now();
		const id = `sts_${crypto.randomUUID().replaceAll("-", "")}`;
		const row = this.#db
			.query<
				StudioSessionRow,
				[string, string, string, string | null, string, string, StudioSessionStatus, number, number]
			>(
				`INSERT INTO studio_sessions (
					id, profile, workspace_id, name, model_provider, model_id, status, created_at_ms, updated_at_ms
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 RETURNING id, profile, workspace_id, omp_session_id, omp_session_ref, name, model_provider, model_id,
					status, created_at_ms, updated_at_ms, last_activity_at_ms, usage_json, usage_updated_at_ms`,
			)
			.get(
				id,
				input.profile,
				input.workspaceId,
				input.name ?? null,
				input.model.provider,
				input.model.id,
				"starting",
				now,
				now,
			);
		if (!row) throw new Error("Studio session insert did not return a row");
		return toStudioSession(row);
	}

	listStudioSessions(): StudioSession[] {
		const rows = this.#db
			.query<StudioSessionRow, []>(
				`SELECT id, profile, workspace_id, omp_session_id, omp_session_ref, name, model_provider, model_id,
					status, created_at_ms, updated_at_ms, last_activity_at_ms, usage_json, usage_updated_at_ms
				 FROM studio_sessions ORDER BY updated_at_ms DESC, id`,
			)
			.all();
		return rows.map(row => toStudioSession(row, this.#getActiveRunForSession(row.id)));
	}

	getStudioSession(studioSessionId: string): StudioSession | undefined {
		return this.getStoredStudioSession(studioSessionId)?.session;
	}

	getStoredStudioSession(studioSessionId: string): StudioStoredSession | undefined {
		const row = this.#db
			.query<StudioSessionRow, [string]>(
				`SELECT id, profile, workspace_id, omp_session_id, omp_session_ref, name, model_provider, model_id,
					status, created_at_ms, updated_at_ms, last_activity_at_ms, usage_json, usage_updated_at_ms
				 FROM studio_sessions WHERE id = ?`,
			)
			.get(studioSessionId);
		if (!row) return undefined;
		return {
			...(row.omp_session_id === null ? {} : { ompSessionId: row.omp_session_id }),
			...(row.omp_session_ref === null ? {} : { ompSessionRef: row.omp_session_ref }),
			session: toStudioSession(row, this.#getActiveRunForSession(studioSessionId)),
		};
	}

	updateStudioSessionRuntime(
		studioSessionId: string,
		input: UpdateStudioSessionRuntimeInput,
	): StudioSession | undefined {
		const now = Date.now();
		const row = this.#db
			.query<StudioSessionRow, [StudioSessionStatus, string | null, string | null, number, number, string]>(
				`UPDATE studio_sessions SET
					status = ?,
					omp_session_id = COALESCE(?, omp_session_id),
					omp_session_ref = COALESCE(?, omp_session_ref),
					updated_at_ms = ?,
					last_activity_at_ms = ?
				 WHERE id = ?
				 RETURNING id, profile, workspace_id, omp_session_id, omp_session_ref, name, model_provider, model_id,
					status, created_at_ms, updated_at_ms, last_activity_at_ms, usage_json, usage_updated_at_ms`,
			)
			.get(input.status, input.ompSessionId ?? null, input.ompSessionRef ?? null, now, now, studioSessionId);
		return row ? toStudioSession(row, this.#getActiveRunForSession(studioSessionId)) : undefined;
	}

	updateStudioSessionUsage(
		studioSessionId: string,
		usage: Omit<StudioUsage, "updatedAtMs">,
		now = Date.now(),
	): StudioSession | undefined {
		const usageJson = encodeStudioUsage(usage);
		const row = this.#db
			.query<StudioSessionRow, [string, number, number, number, string]>(
				`UPDATE studio_sessions SET
					usage_json = ?,
					usage_updated_at_ms = ?,
					updated_at_ms = ?,
					last_activity_at_ms = ?
				 WHERE id = ?
				 RETURNING id, profile, workspace_id, omp_session_id, omp_session_ref, name, model_provider, model_id,
					status, created_at_ms, updated_at_ms, last_activity_at_ms, usage_json, usage_updated_at_ms`,
			)
			.get(usageJson, now, now, now, studioSessionId);
		return row ? toStudioSession(row, this.#getActiveRunForSession(studioSessionId)) : undefined;
	}

	createStudioRun(studioSessionId: string, rpcProtocolVersion: number): CreateStudioRunResult {
		return this.#transaction(() => {
			const active = this.#getActiveRunForSession(studioSessionId);
			if (active) return { kind: "active", run: active };

			const now = Date.now();
			const id = `run_${crypto.randomUUID().replaceAll("-", "")}`;
			const row = this.#db
				.query<StudioRunRow, [string, string, StudioRunStatus, number, number]>(
					`INSERT INTO runs (id, studio_session_id, status, rpc_protocol_version, started_at_ms)
					 VALUES (?, ?, ?, ?, ?)
					 RETURNING id, studio_session_id, status, rpc_protocol_version, started_at_ms, ended_at_ms, interrupted_reason`,
				)
				.get(id, studioSessionId, "starting", rpcProtocolVersion, now);
			if (!row) throw new Error("Studio run insert did not return a row");
			this.#db
				.query<void, [StudioSessionStatus, number, number, string]>(
					"UPDATE studio_sessions SET status = ?, updated_at_ms = ?, last_activity_at_ms = ? WHERE id = ?",
				)
				.run("running", now, now, studioSessionId);
			return { kind: "created", run: toStudioRun(row) };
		});
	}

	getStudioRun(runId: string): StudioRun | undefined {
		const row = this.#db
			.query<StudioRunRow, [string]>(
				"SELECT id, studio_session_id, status, rpc_protocol_version, started_at_ms, ended_at_ms, interrupted_reason FROM runs WHERE id = ?",
			)
			.get(runId);
		return row ? toStudioRun(row) : undefined;
	}

	listStudioRuns(studioSessionId: string, limit = 60): StudioRun[] {
		const boundedLimit = Math.min(Math.max(limit, 1), 100);
		const rows = this.#db
			.query<StudioRunRow, [string, number]>(
				`SELECT id, studio_session_id, status, rpc_protocol_version, started_at_ms, ended_at_ms, interrupted_reason
				 FROM runs WHERE studio_session_id = ?
				 ORDER BY started_at_ms DESC, id DESC LIMIT ?`,
			)
			.all(studioSessionId, boundedLimit);
		return rows.map(toStudioRun);
	}

	appendStudioUsageHistory(
		input: AppendStudioUsageHistoryInput,
		now = Date.now(),
	): StudioUsageHistoryEntry | undefined {
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("Studio usage history timestamp is invalid.");
		const run = this.getStudioRun(input.runId);
		if (!run || run.studioSessionId !== input.studioSessionId) return undefined;
		const id = `ush_${crypto.randomUUID().replaceAll("-", "")}`;
		const row = this.#db
			.query<StudioUsageHistoryRow, [string, string, string, string, number]>(
				`INSERT OR IGNORE INTO studio_usage_history (
					id, studio_session_id, run_id, usage_json, occurred_at_ms
				 ) VALUES (?, ?, ?, ?, ?)
				 RETURNING id, studio_session_id, run_id, usage_json, occurred_at_ms`,
			)
			.get(id, input.studioSessionId, input.runId, encodeStudioUsage(input.usage), now);
		const entry = row ? toStudioUsageHistoryEntry(row) : undefined;
		if (entry) this.#pruneStudioUsageHistoryEntries(input.studioSessionId);
		return entry;
	}

	listStudioUsageHistory(studioSessionId: string, limit = 60): StudioUsageHistoryEntry[] {
		const boundedLimit = Math.min(Math.max(limit, 1), MAX_STUDIO_USAGE_HISTORY_ENTRIES_PER_SESSION);
		const rows = this.#db
			.query<StudioUsageHistoryRow, [string, number]>(
				`SELECT id, studio_session_id, run_id, usage_json, occurred_at_ms
				 FROM studio_usage_history WHERE studio_session_id = ?
				 ORDER BY ordinal DESC LIMIT ?`,
			)
			.all(studioSessionId, boundedLimit);
		const entries: StudioUsageHistoryEntry[] = [];
		for (const row of rows) {
			const entry = toStudioUsageHistoryEntry(row);
			if (entry) entries.push(entry);
		}
		return entries;
	}

	createStudioUserTranscriptMessage(
		input: CreateStudioUserTranscriptMessageInput,
		now = Date.now(),
	): StudioTranscriptMessage | undefined {
		assertTranscriptText(input.text);
		const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
		const createdAtMs = this.#nextTranscriptCreatedAtMs(input.studioSessionId, now);
		const row = this.#db
			.query<StudioTranscriptMessageRow, [string, string, string, string, number, number, string, string]>(
				`INSERT INTO transcript_messages (
					id, studio_session_id, run_id, source_id, role, text, status, created_at_ms, updated_at_ms
				 )
				 SELECT ?, ?, ?, 'user', 'user', ?, 'completed', ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM runs WHERE id = ? AND studio_session_id = ?
				 )
				 RETURNING id, studio_session_id, run_id, role, text, status, created_at_ms, updated_at_ms`,
			)
			.get(
				id,
				input.studioSessionId,
				input.runId,
				input.text,
				createdAtMs,
				createdAtMs,
				input.runId,
				input.studioSessionId,
			);
		return row ? toStudioTranscriptMessage(row) : undefined;
	}

	upsertStudioAssistantTranscriptMessage(
		input: UpsertStudioAssistantTranscriptMessageInput,
		now = Date.now(),
	): StudioTranscriptMessage | undefined {
		assertTranscriptSourceId(input.sourceId);
		assertTranscriptText(input.text, input.status !== "completed");
		const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
		const createdAtMs = this.#nextTranscriptCreatedAtMs(input.studioSessionId, now);
		const row = this.#db
			.query<
				StudioTranscriptMessageRow,
				[string, string, string, string, string, StudioTranscriptMessageStatus, number, number, string, string]
			>(
				`INSERT INTO transcript_messages (
					id, studio_session_id, run_id, source_id, role, text, status, created_at_ms, updated_at_ms
				 )
				 SELECT ?, ?, ?, ?, 'assistant', ?, ?, ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM runs WHERE id = ? AND studio_session_id = ?
				 )
				 ON CONFLICT(run_id, source_id) DO UPDATE SET
					text = CASE
						WHEN transcript_messages.status IN ('completed', 'failed', 'interrupted') THEN transcript_messages.text
						ELSE excluded.text
					END,
					status = CASE
						WHEN transcript_messages.status IN ('completed', 'failed', 'interrupted') THEN transcript_messages.status
						ELSE excluded.status
					END,
					updated_at_ms = MAX(excluded.updated_at_ms, transcript_messages.created_at_ms, transcript_messages.updated_at_ms)
				 RETURNING id, studio_session_id, run_id, role, text, status, created_at_ms, updated_at_ms`,
			)
			.get(
				id,
				input.studioSessionId,
				input.runId,
				input.sourceId,
				input.text,
				input.status,
				createdAtMs,
				createdAtMs,
				input.runId,
				input.studioSessionId,
			);
		return row ? toStudioTranscriptMessage(row) : undefined;
	}

	listStudioTranscriptMessages(studioSessionId: string): StudioTranscriptMessage[] {
		const rows = this.#db
			.query<StudioTranscriptMessageRow, [string]>(
				`SELECT id, studio_session_id, run_id, role, text, status, created_at_ms, updated_at_ms
				 FROM transcript_messages
				 WHERE studio_session_id = ?
				 ORDER BY ordinal ASC`,
			)
			.all(studioSessionId);
		return rows.map(toStudioTranscriptMessage);
	}

	appendStudioActivityEntry(input: AppendStudioActivityEntryInput, now = Date.now()): StudioActivityEntry | undefined {
		if (!isStudioActivitySubject(input.subject) || !isStudioActivityStatus(input.status)) {
			throw new Error("Studio activity has an invalid subject or status.");
		}
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("Studio activity timestamp is invalid.");
		return this.#transaction(() => {
			const id = `act_${crypto.randomUUID().replaceAll("-", "")}`;
			const row = this.#db
				.query<
					StudioActivityEntryRow,
					[string, string, string, StudioActivitySubject, StudioActivityStatus, number, string, string]
				>(
					`INSERT INTO studio_activity_entries (
						id, studio_session_id, run_id, subject, status, occurred_at_ms
					 )
					 SELECT ?, ?, ?, ?, ?, ?
					 WHERE EXISTS (
						SELECT 1 FROM runs WHERE id = ? AND studio_session_id = ?
					 )
					 RETURNING id, studio_session_id, run_id, subject, status, occurred_at_ms`,
				)
				.get(
					id,
					input.studioSessionId,
					input.runId,
					input.subject,
					input.status,
					now,
					input.runId,
					input.studioSessionId,
				);
			const entry = row ? toStudioActivityEntry(row) : undefined;
			if (!entry) return undefined;
			this.#pruneStudioActivityEntries(input.studioSessionId);
			return entry;
		});
	}

	listStudioActivityEntries(studioSessionId: string): StudioActivityEntry[] {
		const rows = this.#db
			.query<StudioActivityEntryRow, [string, number]>(
				`SELECT id, studio_session_id, run_id, subject, status, occurred_at_ms
				 FROM studio_activity_entries
				 WHERE studio_session_id = ?
				 ORDER BY ordinal DESC
				 LIMIT ?`,
			)
			.all(studioSessionId, MAX_STUDIO_ACTIVITY_ENTRIES_PER_SESSION);
		const entries: StudioActivityEntry[] = [];
		for (const row of rows) {
			const entry = toStudioActivityEntry(row);
			if (entry) entries.push(entry);
		}
		return entries;
	}

	appendStudioToolDisplay(input: AppendStudioToolDisplayInput, now = Date.now()): StudioToolDisplay | undefined {
		if (!isStudioToolDisplayKind(input.kind)) throw new Error("Studio tool display has an invalid kind.");
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("Studio tool display timestamp is invalid.");
		const id = `tcd_${crypto.randomUUID().replaceAll("-", "")}`;
		const row = this.#db
			.query<StudioToolDisplayRow, [string, string, string, StudioToolDisplayKind, number, number, string, string]>(
				`INSERT INTO studio_tool_displays (
					id, studio_session_id, run_id, kind, status, started_at_ms, updated_at_ms
				 )
				 SELECT ?, ?, ?, ?, 'running', ?, ?
				 WHERE EXISTS (
					SELECT 1 FROM runs WHERE id = ? AND studio_session_id = ?
				 )
				 RETURNING id, studio_session_id, run_id, kind, status, started_at_ms, updated_at_ms`,
			)
			.get(id, input.studioSessionId, input.runId, input.kind, now, now, input.runId, input.studioSessionId);
		const display = row ? toStudioToolDisplay(row) : undefined;
		if (display) this.#pruneStudioToolDisplays(input.studioSessionId);
		return display;
	}

	updateStudioToolDisplay(
		id: string,
		status: StudioToolDisplayStatus,
		now = Date.now(),
	): StudioToolDisplay | undefined {
		if (!isStudioToolDisplayStatus(status)) throw new Error("Studio tool display has an invalid status.");
		const row = this.#db
			.query<StudioToolDisplayRow, [StudioToolDisplayStatus, number, string]>(
				`UPDATE studio_tool_displays SET status = ?, updated_at_ms = MAX(?, started_at_ms, updated_at_ms)
				 WHERE id = ?
				 RETURNING id, studio_session_id, run_id, kind, status, started_at_ms, updated_at_ms`,
			)
			.get(status, now, id);
		return row ? toStudioToolDisplay(row) : undefined;
	}

	listStudioToolDisplays(studioSessionId: string): StudioToolDisplay[] {
		const rows = this.#db
			.query<StudioToolDisplayRow, [string, number]>(
				`SELECT id, studio_session_id, run_id, kind, status, started_at_ms, updated_at_ms
				 FROM studio_tool_displays WHERE studio_session_id = ? ORDER BY ordinal DESC LIMIT ?`,
			)
			.all(studioSessionId, MAX_STUDIO_TOOL_DISPLAYS_PER_SESSION);
		return rows.map(toStudioToolDisplay).filter((entry): entry is StudioToolDisplay => entry !== undefined);
	}

	finishStudioRunToolDisplays(
		runId: string,
		status: Extract<StudioToolDisplayStatus, "completed" | "failed" | "cancelled">,
		now = Date.now(),
	): StudioToolDisplay[] {
		const rows = this.#db
			.query<StudioToolDisplayRow, [StudioToolDisplayStatus, number, string]>(
				`UPDATE studio_tool_displays SET status = ?, updated_at_ms = MAX(?, started_at_ms, updated_at_ms)
				 WHERE run_id = ? AND status = 'running'
				 RETURNING id, studio_session_id, run_id, kind, status, started_at_ms, updated_at_ms`,
			)
			.all(status, now, runId);
		return rows.map(toStudioToolDisplay).filter((entry): entry is StudioToolDisplay => entry !== undefined);
	}

	upsertStudioPlanSummary(input: UpdateStudioPlanSummaryInput, now = Date.now()): StudioPlanSummary | undefined {
		const counts = [
			input.totalTaskCount,
			input.pendingTaskCount,
			input.inProgressTaskCount,
			input.completedTaskCount,
			input.blockedTaskCount,
			input.abandonedTaskCount,
		];
		if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) {
			throw new Error("Studio plan summary counts are invalid.");
		}
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("Studio plan summary timestamp is invalid.");
		const row = this.#db
			.query<
				StudioPlanSummaryRow,
				[string, string, number, number, number, number, number, number, number, string, string]
			>(
				`INSERT INTO studio_plan_summaries (
					studio_session_id, run_id, total_task_count, pending_task_count, in_progress_task_count,
					completed_task_count, blocked_task_count, abandoned_task_count, updated_at_ms
				 )
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND studio_session_id = ?)
				 ON CONFLICT(studio_session_id) DO UPDATE SET
					run_id = excluded.run_id,
					total_task_count = excluded.total_task_count,
					pending_task_count = excluded.pending_task_count,
					in_progress_task_count = excluded.in_progress_task_count,
					completed_task_count = excluded.completed_task_count,
					blocked_task_count = excluded.blocked_task_count,
					abandoned_task_count = excluded.abandoned_task_count,
					updated_at_ms = MAX(excluded.updated_at_ms, studio_plan_summaries.updated_at_ms)
				 RETURNING studio_session_id, run_id, total_task_count, pending_task_count, in_progress_task_count,
					completed_task_count, blocked_task_count, abandoned_task_count, updated_at_ms`,
			)
			.get(
				input.studioSessionId,
				input.runId,
				input.totalTaskCount,
				input.pendingTaskCount,
				input.inProgressTaskCount,
				input.completedTaskCount,
				input.blockedTaskCount,
				input.abandonedTaskCount,
				now,
				input.runId,
				input.studioSessionId,
			);
		return row ? toStudioPlanSummary(row) : undefined;
	}

	getStudioPlanSummary(studioSessionId: string): StudioPlanSummary | undefined {
		const row = this.#db
			.query<StudioPlanSummaryRow, [string]>(
				`SELECT studio_session_id, run_id, total_task_count, pending_task_count, in_progress_task_count,
					completed_task_count, blocked_task_count, abandoned_task_count, updated_at_ms
				 FROM studio_plan_summaries WHERE studio_session_id = ?`,
			)
			.get(studioSessionId);
		return row ? toStudioPlanSummary(row) : undefined;
	}

	#nextTranscriptCreatedAtMs(studioSessionId: string, now: number): number {
		const row = this.#db
			.query<StudioTranscriptTimestampRow, [string]>(
				"SELECT MAX(created_at_ms) AS latest_created_at_ms FROM transcript_messages WHERE studio_session_id = ?",
			)
			.get(studioSessionId);
		return Math.max(now, (row?.latest_created_at_ms ?? now - 1) + 1);
	}

	finishStudioTranscriptMessages(
		runId: string,
		status: Extract<StudioTranscriptMessageStatus, "completed" | "failed" | "interrupted">,
		now = Date.now(),
	): StudioTranscriptMessage[] {
		const rows = this.#db
			.query<StudioTranscriptMessageRow, [StudioTranscriptMessageStatus, number, string]>(
				`UPDATE transcript_messages SET status = ?, updated_at_ms = MAX(?, created_at_ms, updated_at_ms)
				 WHERE run_id = ? AND role = 'assistant' AND status = 'streaming'
				 RETURNING id, studio_session_id, run_id, role, text, status, created_at_ms, updated_at_ms`,
			)
			.all(status, now, runId);
		return rows.map(toStudioTranscriptMessage);
	}

	createStudioApproval(input: CreateStudioApprovalInput, now = Date.now()): StudioApproval | undefined {
		const run = this.getStudioRun(input.runId);
		if (!run || !ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) return undefined;
		const id = `apr_${crypto.randomUUID().replaceAll("-", "")}`;
		this.#db
			.query<void, [string, string, string, string, string, StudioApprovalStatus, number, number, string | null]>(
				`INSERT INTO approvals (
					id, run_id, tool_call_id, tool_name, arguments_digest, status, requested_at_ms, expires_at_ms, reason
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.runId,
				input.toolCallId,
				input.toolName,
				input.argumentsDigest,
				"pending",
				now,
				input.expiresAtMs,
				input.reason ?? null,
			);
		return this.getStudioApproval(id);
	}

	getStudioApproval(approvalId: string): StudioApproval | undefined {
		const row = this.#db
			.query<StudioApprovalRow, [string]>(
				`SELECT a.id, a.run_id, r.studio_session_id, a.tool_call_id, a.tool_name, a.arguments_digest, a.status,
					a.requested_at_ms, a.expires_at_ms, a.resolved_at_ms, a.resolution_reason, a.reason
				 FROM approvals AS a
				 JOIN runs AS r ON r.id = a.run_id
				 WHERE a.id = ?`,
			)
			.get(approvalId);
		return row ? toStudioApproval(row) : undefined;
	}

	listStudioApprovals(studioSessionId: string, now = Date.now()): StudioApproval[] {
		this.#expireStudioApprovals(now);
		const rows = this.#db
			.query<StudioApprovalRow, [string]>(
				`SELECT a.id, a.run_id, r.studio_session_id, a.tool_call_id, a.tool_name, a.arguments_digest, a.status,
					a.requested_at_ms, a.expires_at_ms, a.resolved_at_ms, a.resolution_reason, a.reason
				 FROM approvals AS a
				 JOIN runs AS r ON r.id = a.run_id
				 WHERE r.studio_session_id = ?
				 ORDER BY a.requested_at_ms DESC, a.id DESC`,
			)
			.all(studioSessionId);
		return rows.map(toStudioApproval);
	}

	resolveStudioApproval(
		approvalId: string,
		status: Extract<StudioApprovalStatus, "approved" | "rejected">,
		resolutionReason: string,
		now = Date.now(),
	): ResolveStudioApprovalResult {
		this.#expireStudioApprovals(now);
		const approval = this.getStudioApproval(approvalId);
		if (!approval) return { kind: "not_found" };
		if (approval.status === "expired") return { kind: "expired", approval };
		if (approval.status !== "pending") return { kind: "not_pending", approval };
		const result = this.#db
			.query<void, [StudioApprovalStatus, number, string, string, number]>(
				`UPDATE approvals SET status = ?, resolved_at_ms = ?, resolution_reason = ?
				 WHERE id = ? AND status = 'pending' AND expires_at_ms > ?`,
			)
			.run(status, now, resolutionReason, approvalId, now);
		if (result.changes === 0) {
			const current = this.getStudioApproval(approvalId);
			if (!current) return { kind: "not_found" };
			return current.status === "expired"
				? { kind: "expired", approval: current }
				: { kind: "not_pending", approval: current };
		}
		const resolved = this.getStudioApproval(approvalId);
		if (!resolved) throw new Error("Studio approval disappeared after resolution.");
		return { kind: "resolved", approval: resolved };
	}

	interruptStudioRunApprovals(runId: string, reason: string, now = Date.now()): StudioApproval[] {
		const rows = this.#db
			.query<StudioApprovalRow, [string]>(
				`SELECT a.id, a.run_id, r.studio_session_id, a.tool_call_id, a.tool_name, a.arguments_digest, a.status,
					a.requested_at_ms, a.expires_at_ms, a.resolved_at_ms, a.resolution_reason, a.reason
				 FROM approvals AS a
				 JOIN runs AS r ON r.id = a.run_id
				 WHERE a.run_id = ? AND a.status = 'pending'`,
			)
			.all(runId);
		if (rows.length === 0) return [];
		this.#db
			.query<void, [StudioApprovalStatus, number, string, string]>(
				"UPDATE approvals SET status = ?, resolved_at_ms = ?, resolution_reason = ? WHERE run_id = ? AND status = 'pending'",
			)
			.run("interrupted", now, reason, runId);
		return rows.map(row =>
			toStudioApproval({ ...row, status: "interrupted", resolved_at_ms: now, resolution_reason: reason }),
		);
	}

	markStudioRunRunning(runId: string): StudioRun | undefined {
		return this.#updateActiveRunStatus(runId, "running");
	}

	markStudioRunCancelling(runId: string): StudioRun | undefined {
		return this.#updateActiveRunStatus(runId, "cancelling");
	}

	finishStudioRun(
		runId: string,
		status: Exclude<StudioRunStatus, (typeof ACTIVE_RUN_STATUSES)[number]>,
		reason?: string,
	): StudioRun | undefined {
		const now = Date.now();
		const row = this.#db
			.query<StudioRunRow, [StudioRunStatus, number, string | null, string]>(
				`UPDATE runs SET status = ?, ended_at_ms = ?, interrupted_reason = ?
				 WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
				 RETURNING id, studio_session_id, status, rpc_protocol_version, started_at_ms, ended_at_ms, interrupted_reason`,
			)
			.get(status, now, reason ?? null, runId);
		return row ? toStudioRun(row) : this.getStudioRun(runId);
	}

	interruptActiveRuntime(reason: string, now = Date.now()): void {
		this.#transaction(() => {
			this.#db
				.query<void, [StudioApprovalStatus, number, string]>(
					`UPDATE approvals SET status = ?, resolved_at_ms = ?, resolution_reason = ?
					 WHERE status = 'pending' AND run_id IN (
						SELECT id FROM runs WHERE status IN ('starting', 'running', 'cancelling')
					 )`,
				)
				.run("interrupted", now, reason);
			this.#db
				.query<void, [StudioTranscriptMessageStatus, number]>(
					`UPDATE transcript_messages SET status = ?, updated_at_ms = MAX(?, created_at_ms, updated_at_ms)
					 WHERE role = 'assistant' AND status = 'streaming' AND run_id IN (
						SELECT id FROM runs WHERE status IN ('starting', 'running', 'cancelling')
					 )`,
				)
				.run("interrupted", now);
			this.#db
				.query<void, [number]>(
					`UPDATE studio_tool_displays SET status = 'cancelled', updated_at_ms = MAX(?, started_at_ms, updated_at_ms)
					 WHERE status = 'running' AND run_id IN (
						SELECT id FROM runs WHERE status IN ('starting', 'running', 'cancelling')
					 )`,
				)
				.run(now);
			this.#db
				.query<void, [StudioSessionStatus, number, number]>(
					`UPDATE studio_sessions SET status = ?, updated_at_ms = ?, last_activity_at_ms = ?
					 WHERE id IN (
						SELECT studio_session_id FROM runs WHERE status IN ('starting', 'running', 'cancelling')
					 )`,
				)
				.run("interrupted", now, now);
			this.#db
				.query<void, [StudioRunStatus, number, string]>(
					`UPDATE runs SET status = ?, ended_at_ms = ?, interrupted_reason = ?
					 WHERE status IN ('starting', 'running', 'cancelling')`,
				)
				.run("interrupted", now, reason);
			this.#db.exec("DELETE FROM control_leases");
		});
	}

	acquireControlLease(
		studioSessionId: string,
		holderId: string,
		ttlMs: number,
		now = Date.now(),
	): AcquireControlLeaseResult {
		if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
			throw new Error(`Control lease TTL must be a positive integer, received ${ttlMs}.`);
		}
		const expiresAtMs = now + ttlMs;
		const acquired = this.#db
			.query<LeaseRow, [string, string, number, number, number]>(
				`INSERT INTO control_leases (studio_session_id, holder_id, issued_at_ms, expires_at_ms)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(studio_session_id) DO UPDATE SET
				 	holder_id = excluded.holder_id,
				 	issued_at_ms = excluded.issued_at_ms,
				 	expires_at_ms = excluded.expires_at_ms
				 WHERE control_leases.expires_at_ms <= ? OR control_leases.holder_id = excluded.holder_id
				 RETURNING studio_session_id, holder_id, issued_at_ms, expires_at_ms`,
			)
			.get(studioSessionId, holderId, now, expiresAtMs, now);
		if (acquired) return { kind: "acquired", lease: toLease(acquired) };

		const held = this.#db
			.query<LeaseRow, [string]>(
				"SELECT studio_session_id, holder_id, issued_at_ms, expires_at_ms FROM control_leases WHERE studio_session_id = ?",
			)
			.get(studioSessionId);
		if (!held) throw new Error(`Studio control lease lookup failed for session ${studioSessionId}.`);
		return { kind: "held", lease: toLease(held) };
	}

	hasControlLease(studioSessionId: string, holderId: string, now = Date.now()): boolean {
		return (
			this.#db
				.query<{ present: number }, [string, string, number]>(
					`SELECT 1 AS present FROM control_leases
					 WHERE studio_session_id = ? AND holder_id = ? AND expires_at_ms > ?`,
				)
				.get(studioSessionId, holderId, now) !== null
		);
	}

	releaseControlLease(studioSessionId: string, holderId: string): boolean {
		const result = this.#db
			.query<void, [string, string]>("DELETE FROM control_leases WHERE studio_session_id = ? AND holder_id = ?")
			.run(studioSessionId, holderId);
		return result.changes > 0;
	}

	listStudioAuditEntries(input: ListStudioAuditEntriesInput = {}): ListStudioAuditEntriesResult {
		const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
		const rows = this.#db
			.query<StudioAuditRow, [string | null, number | null, number]>(
				`SELECT id, occurred_at_ms, action, studio_session_id, run_id, detail_json
				 FROM audit_log
				 WHERE (?1 IS NULL OR studio_session_id = ?1) AND (?2 IS NULL OR id < ?2)
				 ORDER BY id DESC LIMIT ?3`,
			)
			.all(input.studioSessionId ?? null, input.beforeId ?? null, limit + 1);
		const hasMore = rows.length > limit;
		const entries = (hasMore ? rows.slice(0, limit) : rows).map(toStudioAuditEntry);
		const lastEntry = entries.at(-1);
		return {
			entries,
			...(hasMore && lastEntry ? { nextBeforeId: lastEntry.id } : {}),
		};
	}

	appendAuditEntry(input: StudioAuditEntryInput): void {
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.action)) {
			throw new Error(`Studio audit action is invalid: ${input.action}`);
		}
		this.#db
			.query<void, [number, string, string | null, string | null, string]>(
				`INSERT INTO audit_log (occurred_at_ms, action, studio_session_id, run_id, detail_json)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				Date.now(),
				input.action,
				input.studioSessionId ?? null,
				input.runId ?? null,
				JSON.stringify(toStudioAuditDetail(input.detail)),
			);
		this.#pruneAuditEntries();
	}

	#updateActiveRunStatus(
		runId: string,
		status: Extract<StudioRunStatus, "running" | "cancelling">,
	): StudioRun | undefined {
		const row = this.#db
			.query<StudioRunRow, [StudioRunStatus, string]>(
				`UPDATE runs SET status = ? WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
				 RETURNING id, studio_session_id, status, rpc_protocol_version, started_at_ms, ended_at_ms, interrupted_reason`,
			)
			.get(status, runId);
		return row ? toStudioRun(row) : this.getStudioRun(runId);
	}

	#expireStudioApprovals(now: number): void {
		this.#db
			.query<void, [StudioApprovalStatus, number, string, number]>(
				`UPDATE approvals SET status = ?, resolved_at_ms = ?, resolution_reason = ?
				 WHERE status = 'pending' AND expires_at_ms <= ?`,
			)
			.run("expired", now, "approval expired", now);
	}

	#pruneAuditEntries(): void {
		this.#db
			.query<void, [number]>(
				`DELETE FROM audit_log
				 WHERE id <= COALESCE((SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ?), -1)`,
			)
			.run(MAX_AUDIT_ENTRIES);
	}

	#pruneStudioActivityEntries(studioSessionId: string): void {
		this.#db
			.query<void, [string, string, number]>(
				`DELETE FROM studio_activity_entries
				 WHERE studio_session_id = ?
					AND ordinal <= COALESCE((
						SELECT ordinal FROM studio_activity_entries
						WHERE studio_session_id = ?
						ORDER BY ordinal DESC
						LIMIT 1 OFFSET ?
					), -1)`,
			)
			.run(studioSessionId, studioSessionId, MAX_STUDIO_ACTIVITY_ENTRIES_PER_SESSION);
	}

	#pruneStudioToolDisplays(studioSessionId: string): void {
		this.#db
			.query<void, [string, string, number]>(
				`DELETE FROM studio_tool_displays
				 WHERE studio_session_id = ?
					AND ordinal <= COALESCE((
						SELECT ordinal FROM studio_tool_displays
						WHERE studio_session_id = ?
						ORDER BY ordinal DESC
						LIMIT 1 OFFSET ?
					), -1)`,
			)
			.run(studioSessionId, studioSessionId, MAX_STUDIO_TOOL_DISPLAYS_PER_SESSION);
	}

	#pruneStudioUsageHistoryEntries(studioSessionId: string): void {
		this.#db
			.query<void, [string, string, number]>(
				`DELETE FROM studio_usage_history
				 WHERE studio_session_id = ?
					AND ordinal <= COALESCE((
						SELECT ordinal FROM studio_usage_history
						WHERE studio_session_id = ?
						ORDER BY ordinal DESC
						LIMIT 1 OFFSET ?
					), -1)`,
			)
			.run(studioSessionId, studioSessionId, MAX_STUDIO_USAGE_HISTORY_ENTRIES_PER_SESSION);
	}

	#getActiveRunForSession(studioSessionId: string): StudioRun | undefined {
		const row = this.#db
			.query<StudioRunRow, [string]>(
				`SELECT id, studio_session_id, status, rpc_protocol_version, started_at_ms, ended_at_ms, interrupted_reason
				 FROM runs WHERE studio_session_id = ? AND status IN ('starting', 'running', 'cancelling')
				 ORDER BY started_at_ms DESC, id DESC LIMIT 1`,
			)
			.get(studioSessionId);
		return row ? toStudioRun(row) : undefined;
	}

	#transaction<T>(operation: () => T): T {
		let transactionOpen = false;
		try {
			this.#db.exec("BEGIN IMMEDIATE");
			transactionOpen = true;
			const result = operation();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			if (transactionOpen) {
				try {
					this.#db.exec("ROLLBACK");
				} catch {
					// Preserve the original operation error when SQLite has already rolled back.
				}
			}
			throw error;
		}
	}
}
