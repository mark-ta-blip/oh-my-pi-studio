import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createStudioChangeReviewAdapter, type StudioChangeReviewGit } from "../src/cli/studio-change-review";
import type { FileDiff, FileHunks } from "../src/commit/types";

interface FakeGitData {
	repoRoot: string | null;
	stagedFiles?: FileDiff[];
	stagedHunks?: FileHunks[];
	status?: string;
	unstagedFiles?: FileDiff[];
	unstagedHunks?: FileHunks[];
}

function createFakeGit(data: FakeGitData): StudioChangeReviewGit {
	return {
		diff: async (_cwd, options) => (options.cached ? "staged" : "unstaged"),
		parseFiles: text => (text === "staged" ? (data.stagedFiles ?? []) : (data.unstagedFiles ?? [])),
		parseHunks: text => (text === "staged" ? (data.stagedHunks ?? []) : (data.unstagedHunks ?? [])),
		repoRoot: async () => data.repoRoot,
		status: async () => data.status ?? "",
	};
}

function file(filename: string, additions = 1, deletions = 0, isBinary = false): FileDiff {
	return { additions, content: "", deletions, filename, isBinary };
}

function hunks(filename: string, content: string): FileHunks {
	return {
		filename,
		hunks: [{ content, header: "@@ -1,1 +1,1 @@", index: 0, newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 }],
		isBinary: false,
	};
}

describe("Studio change review projection", () => {
	it("returns a bounded project-relative staged and unstaged diff without credential values", async () => {
		const repoRoot = path.join(process.cwd(), "studio-change-review-repo");
		const workspacePath = path.join(repoRoot, "project");
		const filename = "project/src/app.ts";
		const adapter = createStudioChangeReviewAdapter({
			git: createFakeGit({
				repoRoot,
				stagedFiles: [file(filename)],
				stagedHunks: [hunks(filename, '-const API_KEY = "old-secret";\n+const API_KEY = "new-secret";')],
				status: `MM ${filename}\0`,
				unstagedFiles: [file(filename, 0, 1)],
				unstagedHunks: [hunks(filename, "+const authorization = 'Bearer token-value';")],
			}),
			now: () => 123,
		});

		const changeSet = await adapter.getChangeSet({ workspacePath });

		expect(changeSet).toMatchObject({
			additions: 1,
			deletions: 1,
			fileCount: 1,
			generatedAtMs: 123,
			stagedFileCount: 1,
			truncated: false,
			unstagedFileCount: 1,
		});
		expect(changeSet.files[0]).toMatchObject({
			path: "src/app.ts",
			staged: true,
			status: "modified",
			unstaged: true,
		});
		const preview = changeSet.files[0]?.hunks.flatMap(hunk => hunk.lines.map(line => line.text)).join("\n") ?? "";
		expect(preview).toContain("[redacted]");
		expect(preview).not.toContain("old-secret");
		expect(preview).not.toContain("new-secret");
		expect(preview).not.toContain("token-value");
	});

	it("excludes untracked, binary, sensitive, absolute, and traversal paths from the browser payload", async () => {
		const repoRoot = path.join(process.cwd(), "studio-change-review-repo");
		const workspacePath = path.join(repoRoot, "project");
		const adapter = createStudioChangeReviewAdapter({
			git: createFakeGit({
				repoRoot,
				stagedFiles: [
					file("project/.env"),
					file("project/assets/archive.bin", 0, 0, true),
					file("project/src/visible.ts"),
					file("../outside.ts"),
					file("/absolute.ts"),
				],
				status:
					"?? project/untracked.txt\0 M project/.env\0 M project/assets/archive.bin\0 M project/src/visible.ts\0",
			}),
		});

		const changeSet = await adapter.getChangeSet({ workspacePath });

		expect(changeSet.files.map(change => change.path)).toEqual(["src/visible.ts"]);
		expect(changeSet.truncated).toBe(true);
		expect(JSON.stringify(changeSet)).not.toContain(".env");
		expect(JSON.stringify(changeSet)).not.toContain("archive.bin");
		expect(JSON.stringify(changeSet)).not.toContain("untracked.txt");
		expect(JSON.stringify(changeSet)).not.toContain("outside.ts");
	});

	it("caps a large change set and every displayed hunk preview", async () => {
		const repoRoot = path.join(process.cwd(), "studio-change-review-repo");
		const workspacePath = path.join(repoRoot, "project");
		const filenames = Array.from(
			{ length: 205 },
			(_, index) => `project/src/file-${String(index).padStart(3, "0")}.ts`,
		);
		const hunkContent = Array.from({ length: 81 }, (_, index) => `+line ${index}`).join("\n");
		const firstFile = filenames[0] ?? "";
		const firstFileHunks = hunks(firstFile, hunkContent);
		firstFileHunks.hunks = Array.from({ length: 7 }, (_, index) => ({
			content: hunkContent,
			header: "@@ -1,1 +1,1 @@",
			index,
			newLines: 1,
			newStart: index + 1,
			oldLines: 1,
			oldStart: index + 1,
		}));
		const adapter = createStudioChangeReviewAdapter({
			git: createFakeGit({
				repoRoot,
				stagedFiles: filenames.map(filename => file(filename)),
				stagedHunks: [firstFileHunks],
			}),
		});

		const changeSet = await adapter.getChangeSet({ workspacePath });

		expect(changeSet.fileCount).toBe(200);
		expect(changeSet.truncated).toBe(true);
		const firstChange = changeSet.files.find(change => change.path === "src/file-000.ts");
		expect(firstChange?.hunks).toHaveLength(6);
		expect(firstChange?.hunks[0]?.lines).toHaveLength(80);
		expect(firstChange?.previewTruncated).toBe(true);
	});

	it("reports a non-repository through the stable adapter error", async () => {
		const adapter = createStudioChangeReviewAdapter({
			git: createFakeGit({ repoRoot: null }),
		});

		await expect(adapter.getChangeSet({ workspacePath: process.cwd() })).rejects.toMatchObject({
			code: "not_repository",
		});
	});
});
