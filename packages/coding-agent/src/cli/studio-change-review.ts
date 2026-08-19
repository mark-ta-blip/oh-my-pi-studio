import * as path from "node:path";
import {
	type StudioChangeFile,
	type StudioChangePreviewHunk,
	type StudioChangePreviewLine,
	type StudioChangeReviewAdapter,
	StudioChangeReviewError,
	type StudioChangeReviewRequest,
	type StudioChangeSet,
	type StudioChangeStatus,
} from "@oh-my-pi/omp-studio";
import type { FileDiff, FileHunks } from "../commit/types";
import * as git from "../utils/git";

const MAX_STUDIO_CHANGE_FILES = 200;
const MAX_STUDIO_CHANGE_PREVIEW_HUNKS_PER_FILE = 6;
const MAX_STUDIO_CHANGE_PREVIEW_LINES_PER_HUNK = 80;
const MAX_STUDIO_CHANGE_PREVIEW_LINE_LENGTH = 240;
const SENSITIVE_CHANGE_PATH =
	/(?:^|\/)(?:\.env(?:\..+)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|credentials?(?:\..+)?|secrets?(?:\..+)?)$/i;
const SENSITIVE_ASSIGNMENT =
	/((?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|secret|password|private[_ -]?key|token)\s*(?:[:=]|=>)\s*)[^\r\n]+/gi;
const BEARER_CREDENTIAL = /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;

interface StudioGitDiffOptions {
	binary?: boolean;
	cached?: boolean;
	files?: readonly string[];
	signal?: AbortSignal;
}

interface StudioGitStatusOptions {
	pathspecs?: readonly string[];
	porcelainV1?: boolean;
	signal?: AbortSignal;
	untrackedFiles?: "all" | "no" | "normal";
	z?: boolean;
}

export interface StudioChangeReviewGit {
	diff(cwd: string, options: StudioGitDiffOptions): Promise<string>;
	parseFiles(text: string): FileDiff[];
	parseHunks(text: string): FileHunks[];
	repoRoot(cwd: string, signal?: AbortSignal): Promise<string | null>;
	status(cwd: string, options: StudioGitStatusOptions): Promise<string>;
}

export interface CreateStudioChangeReviewAdapterOptions {
	git?: StudioChangeReviewGit;
	now?: () => number;
}

interface StudioStatusEntry {
	staged: boolean;
	status: StudioChangeStatus;
	untracked: boolean;
	unstaged: boolean;
}

const codingAgentGit: StudioChangeReviewGit = {
	diff: (cwd, options) => git.diff(cwd, options),
	parseFiles: text => git.diff.parseFiles(text),
	parseHunks: text => git.diff.parseHunks(text),
	repoRoot: (cwd, signal) => git.repo.root(cwd, signal),
	status: (cwd, options) => git.status(cwd, options),
};

function isSafeProjectPath(value: string): boolean {
	if (!value || value.length > 512 || /[\u0000-\u001F\u007F]/.test(value) || value.includes("\\")) return false;
	if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
	return value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function isPathInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toProjectRelativePath(rawPath: string, repoRoot: string, workspacePath: string): string | undefined {
	if (!isSafeProjectPath(rawPath)) return undefined;
	const absolutePath = path.resolve(repoRoot, ...rawPath.split("/"));
	if (!isPathInside(workspacePath, absolutePath)) return undefined;
	const relativePath = path.relative(workspacePath, absolutePath).replaceAll(path.sep, "/");
	return isSafeProjectPath(relativePath) ? relativePath : undefined;
}

function sanitizePreviewText(value: string): string {
	const sanitized = value
		.replaceAll("\r", "")
		.replaceAll("\t", "  ")
		.replace(/[\u0000-\u001F\u007F]/g, "")
		.replace(SENSITIVE_ASSIGNMENT, "$1[redacted]")
		.replace(BEARER_CREDENTIAL, "$1[redacted]");
	return sanitized.length <= MAX_STUDIO_CHANGE_PREVIEW_LINE_LENGTH
		? sanitized
		: `${sanitized.slice(0, MAX_STUDIO_CHANGE_PREVIEW_LINE_LENGTH - 3)}...`;
}

function projectPreviewHunk(hunk: FileHunks["hunks"][number]): StudioChangePreviewHunk {
	const lines: StudioChangePreviewLine[] = [];
	let truncated = false;
	for (const rawLine of hunk.content.split("\n")) {
		if (rawLine.startsWith("@@") || rawLine.startsWith("\\ No newline")) continue;
		if (lines.length >= MAX_STUDIO_CHANGE_PREVIEW_LINES_PER_HUNK) {
			truncated = true;
			break;
		}
		const prefix = rawLine[0];
		const kind = prefix === "+" ? "addition" : prefix === "-" ? "deletion" : "context";
		const text = prefix === "+" || prefix === "-" || prefix === " " ? rawLine.slice(1) : rawLine;
		lines.push({ kind, text: sanitizePreviewText(text) });
	}
	return {
		lines,
		newLineCount: Math.max(0, hunk.newLines),
		newStart: Math.max(0, hunk.newStart),
		oldLineCount: Math.max(0, hunk.oldLines),
		oldStart: Math.max(0, hunk.oldStart),
		truncated,
	};
}

function statusFromPorcelain(indexStatus: string, worktreeStatus: string): StudioChangeStatus {
	const status = `${indexStatus}${worktreeStatus}`;
	if (status.includes("U")) return "conflicted";
	if (status.includes("D")) return "deleted";
	if (status.includes("R") || status.includes("C")) return "renamed";
	if (status.includes("A")) return "added";
	if (status === "??") return "untracked";
	return "modified";
}

function parseStatusPorcelain(output: string): Map<string, StudioStatusEntry> {
	const entries = new Map<string, StudioStatusEntry>();
	const records = output.includes("\0") ? output.split("\0") : output.split("\n");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? "";
		if (record.length < 4 || record[2] !== " ") continue;
		const indexStatus = record[0] ?? " ";
		const worktreeStatus = record[1] ?? " ";
		const entryPath = record.slice(3);
		if ((indexStatus === "R" || indexStatus === "C") && output.includes("\0")) index += 1;
		entries.set(entryPath, {
			staged: indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!",
			status: statusFromPorcelain(indexStatus, worktreeStatus),
			untracked: indexStatus === "?" && worktreeStatus === "?",
			unstaged: worktreeStatus !== " " && worktreeStatus !== "?" && worktreeStatus !== "!",
		});
	}
	return entries;
}

function createMutableChange(pathname: string, status: StudioChangeStatus = "modified"): StudioChangeFile {
	return {
		additions: 0,
		binary: false,
		deletions: 0,
		hunks: [],
		path: pathname,
		previewOmitted: false,
		previewTruncated: false,
		staged: false,
		status,
		untracked: false,
		unstaged: false,
	};
}

function safeCount(value: number): number {
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function workspacePathspec(repoRoot: string, workspacePath: string): string | undefined {
	if (!isPathInside(repoRoot, workspacePath)) return undefined;
	const relative = path.relative(repoRoot, workspacePath).replaceAll(path.sep, "/");
	return relative === "" ? "." : isSafeProjectPath(relative) ? relative : undefined;
}

function addDiffs(
	changes: Map<string, StudioChangeFile>,
	files: FileDiff[],
	hunksByFilename: ReadonlyMap<string, FileHunks>,
	omittedPaths: Set<string>,
	staged: boolean,
	repoRoot: string,
	workspacePath: string,
	markTruncated: () => void,
): void {
	for (const file of files) {
		const pathname = toProjectRelativePath(file.filename, repoRoot, workspacePath);
		if (!pathname) continue;
		if (omittedPaths.has(pathname)) continue;
		if (file.isBinary || SENSITIVE_CHANGE_PATH.test(pathname)) {
			changes.delete(pathname);
			omittedPaths.add(pathname);
			markTruncated();
			continue;
		}
		let change = changes.get(pathname);
		if (!change) {
			if (changes.size >= MAX_STUDIO_CHANGE_FILES) {
				markTruncated();
				continue;
			}
			change = createMutableChange(pathname);
			changes.set(pathname, change);
		}
		change.staged ||= staged;
		change.unstaged ||= !staged;
		change.binary ||= file.isBinary;
		change.additions += safeCount(file.additions);
		change.deletions += safeCount(file.deletions);
		for (const hunk of hunksByFilename.get(file.filename)?.hunks ?? []) {
			if (change.hunks.length >= MAX_STUDIO_CHANGE_PREVIEW_HUNKS_PER_FILE) {
				change.previewTruncated = true;
				break;
			}
			const preview = projectPreviewHunk(hunk);
			change.hunks.push(preview);
			change.previewTruncated ||= preview.truncated;
		}
	}
}

function summarizeChanges(changes: StudioChangeFile[], truncated: boolean, generatedAtMs: number): StudioChangeSet {
	return {
		additions: changes.reduce((total, file) => total + file.additions, 0),
		deletions: changes.reduce((total, file) => total + file.deletions, 0),
		fileCount: changes.length,
		files: changes,
		generatedAtMs,
		stagedFileCount: changes.filter(file => file.staged).length,
		truncated,
		untrackedFileCount: changes.filter(file => file.untracked).length,
		unstagedFileCount: changes.filter(file => file.unstaged).length,
	};
}

/**
 * Builds the injected, server-side change projection used by Studio. It keeps
 * all Git invocation inside the coding-agent's hardened Git utility.
 */
export function createStudioChangeReviewAdapter(
	options: CreateStudioChangeReviewAdapterOptions = {},
): StudioChangeReviewAdapter {
	const gitApi = options.git ?? codingAgentGit;
	const now = options.now ?? Date.now;
	return {
		async getChangeSet(request: StudioChangeReviewRequest): Promise<StudioChangeSet> {
			const workspacePath = path.resolve(request.workspacePath);
			let repoRoot: string | null;
			try {
				repoRoot = await gitApi.repoRoot(workspacePath, request.signal);
			} catch {
				throw new StudioChangeReviewError(
					"unavailable",
					"Studio could not inspect the registered project's Git state.",
				);
			}
			if (!repoRoot) {
				throw new StudioChangeReviewError("not_repository", "The registered project is not a Git repository.");
			}
			const resolvedRepoRoot = path.resolve(repoRoot);
			const pathspec = workspacePathspec(resolvedRepoRoot, workspacePath);
			if (!pathspec) {
				throw new StudioChangeReviewError("not_repository", "The registered project is not a Git repository.");
			}

			let stagedDiff: string;
			let statusOutput: string;
			let unstagedDiff: string;
			try {
				[stagedDiff, statusOutput, unstagedDiff] = await Promise.all([
					gitApi.diff(resolvedRepoRoot, {
						binary: false,
						cached: true,
						files: [pathspec],
						signal: request.signal,
					}),
					gitApi.status(resolvedRepoRoot, {
						pathspecs: [pathspec],
						porcelainV1: true,
						signal: request.signal,
						untrackedFiles: "all",
						z: true,
					}),
					gitApi.diff(resolvedRepoRoot, { binary: false, files: [pathspec], signal: request.signal }),
				]);
			} catch {
				throw new StudioChangeReviewError(
					"unavailable",
					"Studio could not inspect the registered project's Git state.",
				);
			}

			const changes = new Map<string, StudioChangeFile>();
			const omittedPaths = new Set<string>();
			let truncated = false;
			const markTruncated = (): void => {
				truncated = true;
			};
			const stagedFiles = gitApi.parseFiles(stagedDiff);
			const unstagedFiles = gitApi.parseFiles(unstagedDiff);
			addDiffs(
				changes,
				stagedFiles,
				new Map(gitApi.parseHunks(stagedDiff).map(file => [file.filename, file])),
				omittedPaths,
				true,
				resolvedRepoRoot,
				workspacePath,
				markTruncated,
			);
			addDiffs(
				changes,
				unstagedFiles,
				new Map(gitApi.parseHunks(unstagedDiff).map(file => [file.filename, file])),
				omittedPaths,
				false,
				resolvedRepoRoot,
				workspacePath,
				markTruncated,
			);

			for (const [rawPath, status] of parseStatusPorcelain(statusOutput)) {
				const pathname = toProjectRelativePath(rawPath, resolvedRepoRoot, workspacePath);
				if (!pathname) continue;
				if (omittedPaths.has(pathname)) continue;
				if (status.untracked || SENSITIVE_CHANGE_PATH.test(pathname)) {
					changes.delete(pathname);
					omittedPaths.add(pathname);
					markTruncated();
					continue;
				}
				let change = changes.get(pathname);
				if (!change) {
					if (changes.size >= MAX_STUDIO_CHANGE_FILES) {
						markTruncated();
						continue;
					}
					change = createMutableChange(pathname, status.status);
					changes.set(pathname, change);
				}
				change.status = status.status;
				change.staged ||= status.staged;
				change.unstaged ||= status.unstaged;
				change.untracked ||= status.untracked;
			}

			return summarizeChanges(
				[...changes.values()].sort((left, right) => left.path.localeCompare(right.path)),
				truncated,
				now(),
			);
		},
	};
}
