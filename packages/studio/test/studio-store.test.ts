import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { StudioStore } from "../src/core/studio-store";
import type { StudioAuditDetail } from "../src/protocol";

const tempDirs: string[] = [];

async function createStore(): Promise<StudioStore> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-store-test-"));
	tempDirs.push(root);
	return StudioStore.open({ dbPath: path.join(root, "studio.db") });
}

function seedStudioSession(dbPath: string, sessionId: string): void {
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
			[sessionId, "default", "wsp_seed", "idle", 1, 1],
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
