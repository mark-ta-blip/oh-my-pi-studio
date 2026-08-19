import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import {
	type AppendStudioToolDisplayInput,
	StudioStore,
	type UpdateStudioPlanSummaryInput,
} from "../src/core/studio-store";
import type {
	StudioActivityEntry,
	StudioAuditDetail,
	StudioPlanSummary,
	StudioToolDisplay,
	StudioUsageHistoryEntry,
} from "../src/protocol";

const tempDirs: string[] = [];

async function createStore(): Promise<StudioStore> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-store-test-"));
	tempDirs.push(root);
	return StudioStore.open({ dbPath: path.join(root, "studio.db") });
}

function seedStudioSession(dbPath: string, sessionId: string, status = "ready"): void {
	const db = new Database(dbPath);
	try {
		db.exec("PRAGMA foreign_keys = ON");
		db.run(
			`INSERT INTO workspaces (id, canonical_path, label, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?)`,
			["wsp_seed", "C:/studio-seed", "Seed workspace", 1, 1],
		);
		db.run(
			`INSERT INTO studio_sessions (id, profile, workspace_id, status, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[sessionId, "default", "wsp_seed", status, 1, 1],
		);
	} finally {
		db.close(true);
	}
}

async function removeTestTempDir(dir: string): Promise<void> {
	try {
		await removeWithRetries(dir);
	} catch (error) {
		const isWindowsLock =
			process.platform === "win32" &&
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "EBUSY" || error.code === "ENOTEMPTY" || error.code === "EPERM");
		if (!isWindowsLock) throw error;
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(removeTestTempDir));
});

describe("Studio control leases", () => {
	it("keeps control with the current holder until expiry, then permits an explicit takeover", async () => {
		const store = await createStore();
		try {
			seedStudioSession(store.dbPath, "sts_lease_contract");

			const first = store.acquireControlLease("sts_lease_contract", "tab-one", 1_000, 100);
			expect(first).toEqual({
				kind: "acquired",
				lease: {
					studioSessionId: "sts_lease_contract",
					holderId: "tab-one",
					issuedAtMs: 100,
					expiresAtMs: 1_100,
				},
			});

			const held = store.acquireControlLease("sts_lease_contract", "tab-two", 1_000, 200);
			expect(held).toEqual({
				kind: "held",
				lease: first.lease,
			});

			const renewed = store.acquireControlLease("sts_lease_contract", "tab-one", 1_000, 300);
			expect(renewed).toMatchObject({
				kind: "acquired",
				lease: { holderId: "tab-one", issuedAtMs: 300, expiresAtMs: 1_300 },
			});

			const takeover = store.acquireControlLease("sts_lease_contract", "tab-two", 1_000, 1_301);
			expect(takeover).toMatchObject({
				kind: "acquired",
				lease: { holderId: "tab-two", issuedAtMs: 1_301, expiresAtMs: 2_301 },
			});

			store.interruptActiveRuntime("studio_restart", 1_400);
			expect(store.getStudioSession("sts_lease_contract")).toMatchObject({ status: "ready" });
			expect(store.hasControlLease("sts_lease_contract", "tab-two", 1_400)).toBe(false);
			expect(store.acquireControlLease("sts_lease_contract", "tab-three", 1_000, 1_400)).toMatchObject({
				kind: "acquired",
				lease: { holderId: "tab-three" },
			});
		} finally {
			store.close();
		}
	});
});

describe("Studio runtime recovery", () => {
	it("interrupts the session that owns an active run while preserving idle ready sessions", async () => {
		const store = await createStore();
		try {
			seedStudioSession(store.dbPath, "sts_runtime_contract");
			const created = store.createStudioRun("sts_runtime_contract", 2);
			if (created.kind !== "created") throw new Error("Expected the seeded Studio session to accept a run.");

			store.interruptActiveRuntime("studio_restart", 1_400);
			expect(store.getStudioRun(created.run.id)).toMatchObject({ status: "interrupted" });
			expect(store.getStudioSession("sts_runtime_contract")).toMatchObject({ status: "interrupted" });
		} finally {
			store.close();
		}
	});
});

describe("Studio usage history", () => {
	it("retains bounded browser-safe usage samples across a store restart", async () => {
		const store = await createStore();
		const dbPath = store.dbPath;
		let retained: StudioUsageHistoryEntry[] = [];
		try {
			seedStudioSession(store.dbPath, "sts_usage_history");
			const firstRun = store.createStudioRun("sts_usage_history", 2);
			if (firstRun.kind !== "created") throw new Error("Expected the seeded Studio session to accept a run.");

			for (let index = 1; index <= 121; index += 1) {
				const entry = store.appendStudioUsageHistory(
					{
						runId: firstRun.run.id,
						studioSessionId: "sts_usage_history",
						usage: {
							cacheReadTokens: index,
							cacheWriteTokens: index,
							cost: index / 100,
							inputTokens: index,
							outputTokens: index,
							premiumRequests: 0,
							reasoningTokens: index,
							totalTokens: index,
							toolCalls: index,
						},
					},
					index,
				);
				if (!entry) throw new Error("Expected the usage sample to be linked to the Studio run.");
			}

			retained = store.listStudioUsageHistory("sts_usage_history", 120);
			expect(retained).toHaveLength(120);
			expect(retained[0]).toMatchObject({ runId: firstRun.run.id, usage: { totalTokens: 121 } });
			expect(retained.at(-1)).toMatchObject({ runId: firstRun.run.id, usage: { totalTokens: 2 } });
			expect(JSON.stringify(retained)).not.toContain("omp-session");
		} finally {
			store.close();
		}

		const reopened = await StudioStore.open({ dbPath });
		try {
			expect(reopened.listStudioUsageHistory("sts_usage_history", 120)).toEqual(retained);
		} finally {
			reopened.close();
		}
	});
});

describe("Studio activity timeline", () => {
	it("persists a browser-safe bounded activity snapshot and retains it across store reload", async () => {
		const store = await createStore();
		const dbPath = store.dbPath;
		let retained: StudioActivityEntry[] = [];
		try {
			seedStudioSession(store.dbPath, "sts_activity");
			const created = store.createStudioRun("sts_activity", 2);
			if (created.kind !== "created") throw new Error("Expected the seeded Studio session to accept a run.");

			for (let index = 1; index <= 501; index += 1) {
				const entry = store.appendStudioActivityEntry(
					{
						runId: created.run.id,
						status: index % 2 === 0 ? "completed" : "running",
						studioSessionId: "sts_activity",
						subject: "command",
					},
					index,
				);
				if (!entry) throw new Error("Expected the activity row to be linked to the active Studio run.");
			}

			retained = store.listStudioActivityEntries("sts_activity");
			expect(retained).toHaveLength(500);
			expect(retained[0]).toMatchObject({ occurredAtMs: 501, subject: "command", status: "running" });
			expect(retained.at(-1)).toMatchObject({ occurredAtMs: 2, subject: "command", status: "completed" });
			expect(
				retained.every(
					entry => Object.keys(entry).sort().join(",") === "id,occurredAtMs,runId,status,studioSessionId,subject",
				),
			).toBe(true);
			expect(JSON.stringify(retained)).not.toContain("toolName");
		} finally {
			store.close();
		}

		const reopened = await StudioStore.open({ dbPath });
		try {
			expect(reopened.listStudioActivityEntries("sts_activity")).toEqual(retained);
		} finally {
			reopened.close();
		}
	});
});

describe("Studio tool cards and plan summaries", () => {
	it("persists bounded browser-safe cards and aggregate plan progress without native detail", async () => {
		const store = await createStore();
		const dbPath = store.dbPath;
		let retainedCards: StudioToolDisplay[] = [];
		let retainedPlan: StudioPlanSummary | undefined;
		try {
			seedStudioSession(store.dbPath, "sts_tool_cards");
			const created = store.createStudioRun("sts_tool_cards", 2);
			if (created.kind !== "created") throw new Error("Expected the seeded Studio session to accept a run.");

			const unsafeCardInput = {
				args: { path: "C:\\private\\source.ts", replacement: "replace this secret value" },
				kind: "file_write",
				output: "private tool output",
				runId: created.run.id,
				studioSessionId: "sts_tool_cards",
				toolName: "write",
			} as unknown as AppendStudioToolDisplayInput;
			const first = store.appendStudioToolDisplay(unsafeCardInput, 1);
			if (!first) throw new Error("Expected the first tool card to be linked to the active run.");
			for (let index = 2; index <= 201; index += 1) {
				const card = store.appendStudioToolDisplay(
					{ kind: "command", runId: created.run.id, studioSessionId: "sts_tool_cards" },
					index,
				);
				if (!card) throw new Error("Expected the generated tool card to be linked to the active run.");
			}

			const unsafePlanInput = {
				abandonedTaskCount: 1,
				blockedTaskCount: 1,
				completedTaskCount: 4,
				inProgressTaskCount: 2,
				pendingTaskCount: 3,
				runId: created.run.id,
				studioSessionId: "sts_tool_cards",
				taskText: "replace this secret value in C:\\private\\source.ts",
				totalTaskCount: 11,
			} as unknown as UpdateStudioPlanSummaryInput;
			retainedPlan = store.upsertStudioPlanSummary(unsafePlanInput, 300);
			retainedCards = store.listStudioToolDisplays("sts_tool_cards");

			expect(retainedCards).toHaveLength(200);
			expect(retainedCards[0]).toMatchObject({ kind: "command", startedAtMs: 201, status: "running" });
			expect(retainedCards.every(card => card.id.startsWith("tcd_"))).toBe(true);
			expect(
				retainedCards.every(
					card =>
						Object.keys(card).sort().join(",") === "id,kind,runId,startedAtMs,status,studioSessionId,updatedAtMs",
				),
			).toBe(true);
			expect(retainedPlan).toMatchObject({ completedTaskCount: 4, totalTaskCount: 11, updatedAtMs: 300 });
			expect(
				Object.keys(retainedPlan ?? {})
					.sort()
					.join(","),
			).toBe(
				"abandonedTaskCount,blockedTaskCount,completedTaskCount,inProgressTaskCount,pendingTaskCount,runId,studioSessionId,totalTaskCount,updatedAtMs",
			);
			expect(JSON.stringify({ retainedCards, retainedPlan })).not.toContain("C:\\private\\source.ts");
			expect(JSON.stringify({ retainedCards, retainedPlan })).not.toContain("replace this secret value");
			expect(JSON.stringify({ retainedCards, retainedPlan })).not.toContain("private tool output");
		} finally {
			store.close();
		}

		const reopened = await StudioStore.open({ dbPath });
		try {
			expect(reopened.listStudioToolDisplays("sts_tool_cards")).toEqual(retainedCards);
			expect(reopened.getStudioPlanSummary("sts_tool_cards")).toEqual(retainedPlan);
		} finally {
			reopened.close();
		}
	});
});

describe("Studio audit ledger", () => {
	it("pages control-plane records while filtering unapproved detail keys before review", async () => {
		const store = await createStore();
		try {
			seedStudioSession(store.dbPath, "sts_audit");
			const unsafeDetail = {
				path: "C:\\private\\project\\secret.txt",
				reason: "user prompt contains a secret",
				toolName: "write",
			} as unknown as StudioAuditDetail;
			store.appendAuditEntry({ action: "approval_requested", detail: unsafeDetail, studioSessionId: "sts_audit" });
			store.appendAuditEntry({
				action: "run_started",
				detail: { rpcProtocolVersion: 2 },
				studioSessionId: "sts_audit",
			});
			store.appendAuditEntry({ action: "session_created", detail: { modelId: "example-model" } });

			const firstPage = store.listStudioAuditEntries({ limit: 1, studioSessionId: "sts_audit" });
			expect(firstPage.entries).toEqual([
				{
					id: expect.any(Number),
					occurredAtMs: expect.any(Number),
					action: "run_started",
					studioSessionId: "sts_audit",
					detail: { rpcProtocolVersion: 2 },
				},
			]);
			if (firstPage.nextBeforeId === undefined) throw new Error("Expected the audit page to expose a cursor.");
			expect(firstPage.nextBeforeId).toBe(firstPage.entries[0].id);

			const secondPage = store.listStudioAuditEntries({
				beforeId: firstPage.nextBeforeId,
				limit: 1,
				studioSessionId: "sts_audit",
			});
			expect(secondPage.entries[0]).toMatchObject({
				action: "approval_requested",
				detail: { toolName: "write" },
			});
			expect(JSON.stringify(secondPage)).not.toContain("secret.txt");
			expect(JSON.stringify(secondPage)).not.toContain("user prompt");
		} finally {
			store.close();
		}
	});
});
