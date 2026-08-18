import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type {
	StudioRpcAgentEvent,
	StudioRpcApprovalRequest,
	StudioRpcLaunch,
	StudioRpcSessionState,
	StudioRpcTransport,
	StudioRpcTransportExit,
	StudioRpcTransportFactory,
	StudioRpcUsage,
} from "../src/core/rpc-supervisor";
import type {
	StudioApproval,
	StudioApprovalListResponse,
	StudioAuditListResponse,
	StudioEventEnvelope,
	StudioPromptResponse,
	StudioRun,
	StudioSession,
	StudioSessionResponse,
	StudioSubagent,
	StudioSubagentListResponse,
	StudioUsage,
	StudioWorkspaceResponse,
} from "../src/protocol";
import { type StudioServer, startStudioServer } from "../src/server";

const servers: StudioServer[] = [];
const tempDirs: string[] = [];
const EVENT_TIMEOUT_MS = 1_000;
const HOLDER_A = "studio-holder-alpha-0001";
const HOLDER_B = "studio-holder-beta-00002";

type BunWebSocketConstructor = new (url: string, options: Bun.WebSocketOptions) => WebSocket;

const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

class FakeStudioRpcTransport implements StudioRpcTransport {
	#approvalListeners = new Set<(request: StudioRpcApprovalRequest) => void>();
	#eventListeners = new Set<(event: StudioRpcAgentEvent) => void>();
	#exitListeners = new Set<(exit: StudioRpcTransportExit) => void>();
	#subagentListeners = new Set<(subagent: StudioSubagent) => void>();

	abortCalls = 0;
	approvalDecisions: Array<{ approved: boolean; requestId: string }> = [];
	prompts: string[] = [];
	protocolVersion = 2;
	stopped = false;
	usage: StudioRpcUsage = {
		cacheReadTokens: 4,
		cacheWriteTokens: 5,
		cost: 0.0123,
		contextTokens: 89,
		contextWindow: 200,
		inputTokens: 20,
		outputTokens: 30,
		premiumRequests: 1,
		reasoningTokens: 6,
		toolCalls: 2,
		totalTokens: 65,
	};

	async abort(): Promise<void> {
		this.abortCalls += 1;
	}

	async getSessionState(): Promise<StudioRpcSessionState> {
		return { ompSessionId: "omp-session-alpha", ompSessionRef: "C:\\private\\omp-session.jsonl" };
	}

	async getUsage(): Promise<StudioRpcUsage> {
		return this.usage;
	}

	onApprovalRequest(listener: (request: StudioRpcApprovalRequest) => void): () => void {
		this.#approvalListeners.add(listener);
		return () => this.#approvalListeners.delete(listener);
	}

	onEvent(listener: (event: StudioRpcAgentEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onExit(listener: (exit: StudioRpcTransportExit) => void): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	onSubagentState(listener: (subagent: StudioSubagent) => void): () => void {
		this.#subagentListeners.add(listener);
		return () => this.#subagentListeners.delete(listener);
	}

	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
	}

	async resolveApproval(requestId: string, approved: boolean): Promise<void> {
		this.approvalDecisions.push({ approved, requestId });
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}

	emit(event: StudioRpcAgentEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	emitApproval(request: StudioRpcApprovalRequest): void {
		for (const listener of this.#approvalListeners) listener(request);
	}

	emitExit(expected = false): void {
		for (const listener of this.#exitListeners) listener({ expected });
	}

	emitSubagent(subagent: StudioSubagent): void {
		for (const listener of this.#subagentListeners) listener(subagent);
	}
}

class FakeStudioRpcTransportFactory implements StudioRpcTransportFactory {
	launches: StudioRpcLaunch[] = [];
	transports: FakeStudioRpcTransport[] = [];

	async start(launch: StudioRpcLaunch): Promise<StudioRpcTransport> {
		this.launches.push(launch);
		const transport = new FakeStudioRpcTransport();
		this.transports.push(transport);
		return transport;
	}
}

interface TestStudio {
	factory: FakeStudioRpcTransportFactory;
	root: string;
	studio: StudioServer;
}

async function startTestStudio(): Promise<TestStudio> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-rpc-test-"));
	tempDirs.push(root);
	const factory = new FakeStudioRpcTransportFactory();
	const studio = await startStudioServer({
		dbPath: path.join(root, "studio.db"),
		port: 0,
		rpcTransportFactory: factory,
	});
	servers.push(studio);
	return { factory, root, studio };
}

async function exchangeLocalAccess(studio: StudioServer): Promise<string> {
	const response = await fetch(studio.url, { redirect: "manual" });
	expect(response.status).toBe(302);
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie) throw new Error("Studio local access exchange did not set a cookie");
	return cookie;
}

function eventsUrl(origin: string): string {
	return `${origin.replace(/^http:/, "ws:")}/api/v1/events`;
}

interface StudioEventSubscription {
	close(): void;
	waitFor<T>(predicate: (event: StudioEventEnvelope<unknown>) => boolean): Promise<StudioEventEnvelope<T>>;
}

async function subscribeStudioEvents(studio: StudioServer, cookie: string): Promise<StudioEventSubscription> {
	const socket = new BunWebSocket(eventsUrl(studio.origin), {
		headers: { Cookie: cookie, Origin: studio.origin },
	});
	const events: StudioEventEnvelope<unknown>[] = [];
	const waiters: Array<{
		predicate: (event: StudioEventEnvelope<unknown>) => boolean;
		reject(error: Error): void;
		resolve(event: StudioEventEnvelope<unknown>): void;
	}> = [];
	let closed = false;
	const subscription: StudioEventSubscription = {
		close: () => {
			if (closed) return;
			closed = true;
			for (const waiter of waiters.splice(0)) waiter.reject(new Error("Studio event subscription closed"));
			if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000);
		},
		waitFor: <T>(predicate: (event: StudioEventEnvelope<unknown>) => boolean): Promise<StudioEventEnvelope<T>> => {
			const existing = events.find(predicate);
			if (existing) return Promise.resolve(existing as StudioEventEnvelope<T>);
			const { promise, resolve, reject } = Promise.withResolvers<StudioEventEnvelope<T>>();
			const timeout = setTimeout(() => {
				const index = waiters.findIndex(waiter => waiter.resolve === resolve);
				if (index >= 0) waiters.splice(index, 1);
				reject(new Error("Studio event was not received"));
			}, EVENT_TIMEOUT_MS);
			waiters.push({
				predicate,
				reject: error => {
					clearTimeout(timeout);
					reject(error);
				},
				resolve: event => {
					clearTimeout(timeout);
					resolve(event as StudioEventEnvelope<T>);
				},
			});
			return promise;
		},
	};
	socket.addEventListener("message", event => {
		try {
			const data: unknown = JSON.parse(String(event.data));
			if (!data || typeof data !== "object") throw new Error("Studio event was not an object");
			const envelope = data as StudioEventEnvelope<unknown>;
			events.push(envelope);
			for (let index = waiters.length - 1; index >= 0; index -= 1) {
				const waiter = waiters[index];
				if (!waiter.predicate(envelope)) continue;
				waiters.splice(index, 1);
				waiter.resolve(envelope);
			}
		} catch (error) {
			for (const waiter of waiters.splice(0)) {
				waiter.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
	});
	await subscription.waitFor(event => event.type === "studio.ready");
	return subscription;
}

async function registerWorkspace(
	studio: StudioServer,
	cookie: string,
	workspacePath: string,
): Promise<StudioWorkspaceResponse> {
	const response = await fetch(`${studio.origin}/api/v1/workspaces`, {
		method: "POST",
		headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
		body: JSON.stringify({ path: workspacePath }),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as StudioWorkspaceResponse;
}

async function createSession(
	studio: StudioServer,
	cookie: string,
	workspaceId: string,
	holderId = HOLDER_A,
): Promise<StudioSessionResponse> {
	const response = await fetch(`${studio.origin}/api/v1/sessions`, {
		method: "POST",
		headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
		body: JSON.stringify({ holderId, modelId: "example-model", provider: "example", workspaceId }),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as StudioSessionResponse;
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
	for (const server of servers.splice(0)) server.stop();
	await Promise.all(tempDirs.splice(0).map(removeTestTempDir));
	vi.restoreAllMocks();
});

describe("Studio RPC session supervision", () => {
	it("keeps OMP references server-only, requires the lease, and completes only after a terminal agent_end", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-alpha");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const studioSessionId = created.session.id;
			expect(studioSessionId).toMatch(/^sts_[a-f0-9]{32}$/);
			expect(created.session).toMatchObject({
				model: { id: "example-model", provider: "example" },
				status: "ready",
				workspaceId: workspace.workspace.id,
			});
			expect(JSON.stringify(created)).not.toContain("omp-session.jsonl");
			expect(factory.launches).toEqual([
				{
					cwd: workspacePath,
					model: { id: "example-model", provider: "example" },
					profile: "default",
				},
			]);
			const auditResponse = await fetch(
				`${studio.origin}/api/v1/audit?sessionId=${encodeURIComponent(studioSessionId)}&limit=2`,
				{ headers: { Cookie: cookie } },
			);
			expect(auditResponse.status).toBe(200);
			const audit = (await auditResponse.json()) as StudioAuditListResponse;
			expect(audit.entries.map(entry => entry.action)).toEqual(["session_started", "session_created"]);
			expect(JSON.stringify(audit)).not.toContain("omp-session.jsonl");

			const denied = await fetch(`${studio.origin}/api/v1/sessions/${studioSessionId}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_B, message: "forbidden prompt" }),
			});
			expect(denied.status).toBe(409);
			expect(await denied.json()).toEqual({
				error: {
					code: "control_lease_required",
					message: "This browser tab does not hold the active control lease for the Studio session.",
				},
			});

			const prompted = await fetch(`${studio.origin}/api/v1/sessions/${studioSessionId}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "first prompt" }),
			});
			expect(prompted.status).toBe(202);
			const prompt = (await prompted.json()) as StudioPromptResponse;
			expect(prompt.run).toMatchObject({ status: "running", studioSessionId });
			expect(factory.transports[0].prompts).toEqual(["first prompt"]);

			factory.transports[0].emit({ isTerminal: false, type: "agent_end" });
			const nonTerminal = await events.waitFor<StudioRpcAgentEvent>(
				event =>
					event.type === "agent.event" &&
					event.runId === prompt.run.id &&
					(event.data as StudioRpcAgentEvent).type === "agent_end" &&
					(event.data as StudioRpcAgentEvent).isTerminal === false,
			);
			expect(nonTerminal.data).toEqual({ isTerminal: false, type: "agent_end" });
			const whileContinuing = await fetch(`${studio.origin}/api/v1/sessions/${studioSessionId}`, {
				headers: { Cookie: cookie },
			});
			const whileContinuingBody = (await whileContinuing.json()) as StudioSessionResponse;
			expect(whileContinuingBody.session.activeRun).toMatchObject({ id: prompt.run.id, status: "running" });

			factory.transports[0].emit({ type: "agent_end" });
			const completed = await events.waitFor<StudioRun>(
				event =>
					event.type === "run.state" &&
					event.runId === prompt.run.id &&
					(event.data as StudioRun).status === "completed",
			);
			expect(completed.data).toMatchObject({ id: prompt.run.id, status: "completed" });

			const secondPrompt = await fetch(`${studio.origin}/api/v1/sessions/${studioSessionId}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "cancel this" }),
			});
			const second = (await secondPrompt.json()) as StudioPromptResponse;
			const cancellation = await fetch(`${studio.origin}/api/v1/runs/${second.run.id}/cancel`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A }),
			});
			expect(cancellation.status).toBe(202);
			expect(factory.transports[0].abortCalls).toBe(1);
			factory.transports[0].emit({ type: "agent_end" });
			const cancelled = await events.waitFor<StudioRun>(
				event =>
					event.type === "run.state" &&
					event.runId === second.run.id &&
					(event.data as StudioRun).status === "cancelled",
			);
			expect(cancelled.data).toMatchObject({ id: second.run.id, status: "cancelled" });
		} finally {
			events.close();
		}
	});

	it("marks a live run interrupted when its supervised OMP child exits", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-exit");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const created = await createSession(studio, cookie, workspace.workspace.id);
		const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A, message: "long task" }),
		});
		const prompt = (await promptResponse.json()) as StudioPromptResponse;

		factory.transports[0].emitExit();
		const sessionResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}`, {
			headers: { Cookie: cookie },
		});
		const session = ((await sessionResponse.json()) as StudioSessionResponse).session;
		expect(session).toMatchObject({ id: created.session.id, status: "interrupted" } satisfies Partial<StudioSession>);
		expect(session.activeRun).toBeUndefined();
		const runStatus = await fetch(`${studio.origin}/api/v1/runs/${prompt.run.id}/cancel`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A }),
		});
		expect(runStatus.status).toBe(409);
		expect((await runStatus.json()) as { error: { code: string; message: string } }).toEqual({
			error: { code: "run_not_active", message: "The requested Studio run is no longer active." },
		});
	});

	it("keeps tool approvals redacted, lease-gated, and synchronized with safe usage and subagent updates", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-approval");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "needs approval" }),
			});
			const prompt = (await promptResponse.json()) as StudioPromptResponse;
			const transport = factory.transports[0];
			const approvalRequest: StudioRpcApprovalRequest = {
				argumentsDigest: "sha256:4fbabc0d2aa9",
				reason: "configured tool policy requires confirmation",
				requestId: "native-approval-1",
				toolCallId: "tool-call-1",
				toolName: "write",
			};
			transport.emitApproval(approvalRequest);
			const requested = await events.waitFor<StudioApproval>(
				event => event.type === "approval.requested" && event.runId === prompt.run.id,
			);
			expect(requested.data).toMatchObject({
				argumentsDigest: approvalRequest.argumentsDigest,
				reason: "OMP requires confirmation for this tool.",
				status: "pending",
				toolCallId: approvalRequest.toolCallId,
				toolName: approvalRequest.toolName,
			});
			expect(JSON.stringify(requested.data)).not.toContain("C:\\private\\source.ts");
			expect(JSON.stringify(requested.data)).not.toContain("replace this secret value");

			const approvalId = (requested.data as StudioApproval).id;
			const listedResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/approvals`, {
				headers: { Cookie: cookie },
			});
			expect(listedResponse.status).toBe(200);
			const listed = (await listedResponse.json()) as StudioApprovalListResponse;
			expect(listed.approvals).toHaveLength(1);
			expect(listed.approvals[0]).toMatchObject({ id: approvalId, status: "pending" });

			const denied = await fetch(`${studio.origin}/api/v1/approvals/${approvalId}`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ decision: "approve", holderId: HOLDER_B }),
			});
			expect(denied.status).toBe(409);
			expect(transport.approvalDecisions).toEqual([]);

			const resolvedResponse = await fetch(`${studio.origin}/api/v1/approvals/${approvalId}`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ decision: "approve", holderId: HOLDER_A }),
			});
			expect(resolvedResponse.status).toBe(200);
			expect((await resolvedResponse.json()) as { approval: StudioApproval }).toMatchObject({
				approval: { id: approvalId, status: "approved" },
			});
			expect(transport.approvalDecisions).toEqual([{ approved: true, requestId: approvalRequest.requestId }]);

			const repeated = await fetch(`${studio.origin}/api/v1/approvals/${approvalId}`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ decision: "approve", holderId: HOLDER_A }),
			});
			expect(repeated.status).toBe(409);
			expect(transport.approvalDecisions).toEqual([{ approved: true, requestId: approvalRequest.requestId }]);

			const subagent: StudioSubagent = {
				agent: "scout",
				agentSource: "project",
				id: "subagent-1",
				index: 0,
				requestCount: 2,
				status: "running",
				tokenCount: 88,
				toolCount: 1,
				updatedAtMs: Date.now(),
			};
			transport.emitSubagent(subagent);
			const subagentEvent = await events.waitFor<StudioSubagent>(
				event => event.type === "subagent.state" && event.studioSessionId === created.session.id,
			);
			expect(subagentEvent.data).toMatchObject({ id: subagent.id, status: "running", tokenCount: 88 });
			const subagentsResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/subagents`, {
				headers: { Cookie: cookie },
			});
			const subagents = (await subagentsResponse.json()) as StudioSubagentListResponse;
			expect(subagents.subagents).toEqual([subagent]);
			expect(JSON.stringify(subagents)).not.toContain("omp-session.jsonl");

			transport.emit({ type: "message_end" });
			const usageEvent = await events.waitFor<StudioUsage>(
				event => event.type === "usage.updated" && event.studioSessionId === created.session.id,
			);
			expect(usageEvent.data).toMatchObject({ cost: 0.0123, totalTokens: 65, toolCalls: 2 });
		} finally {
			events.close();
		}
	});

	it("fails closed when a pending approval expires or its run is interrupted", async () => {
		let now = 1_000_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-expiry");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const firstSession = await createSession(studio, cookie, workspace.workspace.id);
		const firstPromptResponse = await fetch(`${studio.origin}/api/v1/sessions/${firstSession.session.id}/prompts`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A, message: "expire this approval" }),
		});
		expect(firstPromptResponse.status).toBe(202);
		const expiringRequest: StudioRpcApprovalRequest = {
			argumentsDigest: "sha256:expire",
			requestId: "native-approval-expired",
			toolCallId: "tool-call-expired",
			toolName: "bash",
		};
		factory.transports[0].emitApproval(expiringRequest);
		now += 5 * 60_000 + 1;
		const expiredListResponse = await fetch(`${studio.origin}/api/v1/sessions/${firstSession.session.id}/approvals`, {
			headers: { Cookie: cookie },
		});
		const expiredList = (await expiredListResponse.json()) as StudioApprovalListResponse;
		const expiredApproval = expiredList.approvals[0];
		expect(expiredApproval.status).toBe("expired");
		expect(factory.transports[0].approvalDecisions).toEqual([
			{ approved: false, requestId: expiringRequest.requestId },
		]);

		const expiredDecision = await fetch(`${studio.origin}/api/v1/approvals/${expiredApproval.id}`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ decision: "approve", holderId: HOLDER_A }),
		});
		expect(expiredDecision.status).toBe(409);
		expect(factory.transports[0].approvalDecisions).toEqual([
			{ approved: false, requestId: expiringRequest.requestId },
		]);

		const secondSession = await createSession(studio, cookie, workspace.workspace.id);
		const secondPromptResponse = await fetch(`${studio.origin}/api/v1/sessions/${secondSession.session.id}/prompts`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A, message: "interrupt this approval" }),
		});
		const secondPrompt = (await secondPromptResponse.json()) as StudioPromptResponse;
		const interruptedRequest: StudioRpcApprovalRequest = {
			argumentsDigest: "sha256:interrupted",
			requestId: "native-approval-interrupted",
			toolCallId: "tool-call-interrupted",
			toolName: "write",
		};
		factory.transports[1].emitApproval(interruptedRequest);
		const interruption = await fetch(`${studio.origin}/api/v1/runs/${secondPrompt.run.id}/cancel`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A }),
		});
		expect(interruption.status).toBe(202);
		expect(factory.transports[1].approvalDecisions).toEqual([
			{ approved: false, requestId: interruptedRequest.requestId },
		]);

		const interruptedListResponse = await fetch(
			`${studio.origin}/api/v1/sessions/${secondSession.session.id}/approvals`,
			{
				headers: { Cookie: cookie },
			},
		);
		const interruptedList = (await interruptedListResponse.json()) as StudioApprovalListResponse;
		const interruptedApproval = interruptedList.approvals[0];
		expect(interruptedApproval.status).toBe("interrupted");
		const interruptedDecision = await fetch(`${studio.origin}/api/v1/approvals/${interruptedApproval.id}`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ decision: "approve", holderId: HOLDER_A }),
		});
		expect(interruptedDecision.status).toBe(409);
		expect(factory.transports[1].approvalDecisions).toEqual([
			{ approved: false, requestId: interruptedRequest.requestId },
		]);
	});
});
