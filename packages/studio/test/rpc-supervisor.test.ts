import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { StudioChangeReviewAdapter } from "../src/core/change-review";
import type {
	StudioRpcAgentEvent,
	StudioRpcApprovalRequest,
	StudioRpcLaunch,
	StudioRpcPlanSummary,
	StudioRpcPromptResult,
	StudioRpcSessionState,
	StudioRpcTranscriptUpdate,
	StudioRpcTransport,
	StudioRpcTransportExit,
	StudioRpcTransportFactory,
	StudioRpcUsage,
} from "../src/core/rpc-supervisor";
import type {
	StudioActivityEntry,
	StudioActivityListResponse,
	StudioAgentEvent,
	StudioApproval,
	StudioApprovalListResponse,
	StudioAuditListResponse,
	StudioChangeSetResponse,
	StudioEventEnvelope,
	StudioPlanSummary,
	StudioPlanSummaryResponse,
	StudioPromptResponse,
	StudioRun,
	StudioRunHistoryResponse,
	StudioSession,
	StudioSessionResponse,
	StudioSubagent,
	StudioSubagentListResponse,
	StudioToolDisplay,
	StudioToolDisplayListResponse,
	StudioTranscriptMessage,
	StudioTranscriptResponse,
	StudioUsage,
	StudioUsageHistoryResponse,
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
	#promptFailureListeners = new Set<() => void>();
	#promptResultListeners = new Set<(result: StudioRpcPromptResult) => void>();
	#planListeners = new Set<(summary: StudioRpcPlanSummary) => void>();
	#subagentListeners = new Set<(subagent: StudioSubagent) => void>();
	#transcriptListeners = new Set<(update: StudioRpcTranscriptUpdate) => void>();

	abortCalls = 0;
	approvalDecisions: Array<{ approved: boolean; requestId: string }> = [];
	promptError: Error | undefined;
	promptGate: Promise<void> | undefined;
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

	onPromptFailure(listener: () => void): () => void {
		this.#promptFailureListeners.add(listener);
		return () => this.#promptFailureListeners.delete(listener);
	}

	onPromptResult(listener: (result: StudioRpcPromptResult) => void): () => void {
		this.#promptResultListeners.add(listener);
		return () => this.#promptResultListeners.delete(listener);
	}

	onPlanSummary(listener: (summary: StudioRpcPlanSummary) => void): () => void {
		this.#planListeners.add(listener);
		return () => this.#planListeners.delete(listener);
	}

	onSubagentState(listener: (subagent: StudioSubagent) => void): () => void {
		this.#subagentListeners.add(listener);
		return () => this.#subagentListeners.delete(listener);
	}

	onTranscriptUpdate(listener: (update: StudioRpcTranscriptUpdate) => void): () => void {
		this.#transcriptListeners.add(listener);
		return () => this.#transcriptListeners.delete(listener);
	}

	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
		await this.promptGate;
		if (this.promptError) throw this.promptError;
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

	emitPromptFailure(): void {
		for (const listener of this.#promptFailureListeners) listener();
	}

	emitPromptResult(agentInvoked: boolean): void {
		for (const listener of this.#promptResultListeners) listener({ agentInvoked });
	}

	emitPlan(summary: StudioRpcPlanSummary): void {
		for (const listener of this.#planListeners) listener(summary);
	}

	emitSubagent(subagent: StudioSubagent): void {
		for (const listener of this.#subagentListeners) listener(subagent);
	}

	emitTranscript(update: StudioRpcTranscriptUpdate): void {
		for (const listener of this.#transcriptListeners) listener(update);
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

async function waitForCondition(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT_MS;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Studio test condition was not reached.");
		await Bun.sleep(5);
	}
}

interface TestStudio {
	factory: FakeStudioRpcTransportFactory;
	root: string;
	studio: StudioServer;
}

async function startTestStudio(changeReviewAdapter?: StudioChangeReviewAdapter): Promise<TestStudio> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-rpc-test-"));
	tempDirs.push(root);
	const factory = new FakeStudioRpcTransportFactory();
	const studio = await startStudioServer({
		changeReviewAdapter,
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
	received(): StudioEventEnvelope<unknown>[];
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
		received: () => [...events],
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
			const nonTerminal = await events.waitFor<StudioAgentEvent>(
				event =>
					event.type === "agent.event" &&
					event.runId === prompt.run.id &&
					(event.data as StudioAgentEvent).type === "agent_end" &&
					(event.data as StudioAgentEvent).isTerminal === false,
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

	it("replays durable fixed-enum activity without disclosing a native tool payload", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-activity");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "Inspect the worktree." }),
			});
			expect(promptResponse.status).toBe(202);
			const prompt = (await promptResponse.json()) as StudioPromptResponse;
			const rawToolEvent = {
				args: {
					command: "type C:\\private\\credentials.txt",
					path: "C:\\private\\credentials.txt",
				},
				result: { output: "private command output" },
				toolCallId: "call_private_tool",
				toolName: "bash",
				type: "tool_execution_start",
			} as unknown as StudioRpcAgentEvent;
			factory.transports[0].emit(rawToolEvent);

			const live = await events.waitFor<StudioActivityEntry>(
				event => event.type === "activity.updated" && event.runId === prompt.run.id,
			);
			expect(live.data).toMatchObject({
				id: expect.stringMatching(/^act_[a-f0-9]{32}$/),
				runId: prompt.run.id,
				status: "running",
				studioSessionId: created.session.id,
				subject: "command",
			});
			expect(JSON.stringify(live.data)).not.toContain("bash");
			expect(JSON.stringify(live.data)).not.toContain("credentials.txt");
			expect(JSON.stringify(live.data)).not.toContain("private command output");
			const browserEvent = await events.waitFor<StudioAgentEvent>(
				event => event.type === "agent.event" && event.runId === prompt.run.id,
			);
			expect(browserEvent.data).toEqual({ type: "tool_execution_start" });
			expect(JSON.stringify(browserEvent.data)).not.toContain("bash");
			expect(JSON.stringify(browserEvent.data)).not.toContain("call_private_tool");

			const snapshotResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/activity`, {
				headers: { Cookie: cookie },
			});
			expect(snapshotResponse.status).toBe(200);
			const snapshot = (await snapshotResponse.json()) as StudioActivityListResponse;
			expect(snapshot.entries).toEqual([live.data]);
			expect(JSON.stringify(snapshot)).not.toContain("call_private_tool");
			expect(JSON.stringify(snapshot)).not.toContain("credentials.txt");
			expect(JSON.stringify(snapshot)).not.toContain("private command output");
		} finally {
			events.close();
		}
	});

	it("persists text-only assistant snapshots and replays the durable transcript", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-transcript");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "Explain the implementation." }),
			});
			expect(promptResponse.status).toBe(202);
			const prompt = (await promptResponse.json()) as StudioPromptResponse;

			const user = await events.waitFor<StudioTranscriptMessage>(
				event =>
					event.type === "transcript.updated" &&
					event.runId === prompt.run.id &&
					(event.data as StudioTranscriptMessage).role === "user",
			);
			expect(user.data).toMatchObject({ role: "user", status: "completed", text: "Explain the implementation." });
			const placeholder = await events.waitFor<StudioTranscriptMessage>(
				event =>
					event.type === "transcript.updated" &&
					event.runId === prompt.run.id &&
					(event.data as StudioTranscriptMessage).role === "assistant" &&
					(event.data as StudioTranscriptMessage).status === "streaming" &&
					(event.data as StudioTranscriptMessage).text === "",
			);
			expect(placeholder.data).toMatchObject({ role: "assistant", status: "streaming", text: "" });

			const transport = factory.transports[0];
			transport.emitTranscript({ sourceId: "assistant_one", status: "streaming", text: "First draft" });
			const streaming = await events.waitFor<StudioTranscriptMessage>(
				event =>
					event.type === "transcript.updated" &&
					event.runId === prompt.run.id &&
					(event.data as StudioTranscriptMessage).text === "First draft",
			);
			expect(streaming.data).toMatchObject({ role: "assistant", status: "streaming", text: "First draft" });

			transport.emitTranscript({ sourceId: "assistant_one", status: "completed", text: "Final answer." });
			transport.emitTranscript({ sourceId: "assistant_two", status: "streaming", text: "A second response." });
			transport.emitTranscript({ sourceId: "assistant_two", status: "completed", text: "A second final response." });
			transport.emit({ type: "agent_end" });
			await events.waitFor<StudioRun>(
				event =>
					event.type === "run.state" &&
					event.runId === prompt.run.id &&
					(event.data as StudioRun).status === "completed",
			);

			const transcriptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/transcript`, {
				headers: { Cookie: cookie },
			});
			expect(transcriptResponse.status).toBe(200);
			const transcript = (await transcriptResponse.json()) as StudioTranscriptResponse;
			expect(
				transcript.messages.map(message => ({ role: message.role, status: message.status, text: message.text })),
			).toEqual([
				{ role: "user", status: "completed", text: "Explain the implementation." },
				{ role: "assistant", status: "completed", text: "Final answer." },
				{ role: "assistant", status: "completed", text: "A second final response." },
			]);
			expect(transcript.messages[0].createdAtMs).toBeLessThan(transcript.messages[1].createdAtMs);
			expect(transcript.messages[1].createdAtMs).toBeLessThan(transcript.messages[2].createdAtMs);
			expect(JSON.stringify(transcript)).not.toContain("assistant_one");
			expect(JSON.stringify(transcript)).not.toContain("assistant_two");
		} finally {
			events.close();
		}
	});

	it("coalesces a burst of streaming snapshots into the final browser transcript event", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-transcript-burst");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "Stream a detailed response." }),
			});
			expect(promptResponse.status).toBe(202);
			const prompt = (await promptResponse.json()) as StudioPromptResponse;
			await events.waitFor<StudioTranscriptMessage>(
				event =>
					event.type === "transcript.updated" &&
					event.runId === prompt.run.id &&
					(event.data as StudioTranscriptMessage).role === "assistant" &&
					(event.data as StudioTranscriptMessage).text === "",
			);
			const eventCountBeforeBurst = events.received().length;
			const transport = factory.transports[0];
			for (let index = 1; index <= 20; index += 1) {
				transport.emitTranscript({
					sourceId: "assistant_burst",
					status: "streaming",
					text: `Partial response ${index}`,
				});
			}
			transport.emitTranscript({
				sourceId: "assistant_burst",
				status: "completed",
				text: "Completed response.",
			});

			const finalSnapshot = await events.waitFor<StudioTranscriptMessage>(
				event =>
					event.type === "transcript.updated" &&
					event.runId === prompt.run.id &&
					(event.data as StudioTranscriptMessage).text === "Completed response.",
			);
			expect(finalSnapshot.data).toMatchObject({ status: "completed", text: "Completed response." });
			const transcriptUpdates = events
				.received()
				.slice(eventCountBeforeBurst)
				.filter(event => event.type === "transcript.updated" && event.runId === prompt.run.id);
			expect(transcriptUpdates).toHaveLength(1);
		} finally {
			events.close();
		}
	});

	it("marks the assistant placeholder failed after a delayed OMP prompt failure", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-transcript-failure");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "This should fail later." }),
			});
			const prompt = (await promptResponse.json()) as StudioPromptResponse;
			factory.transports[0].emitPromptFailure();
			const failed = await events.waitFor<StudioRun>(
				event =>
					event.type === "run.state" &&
					event.runId === prompt.run.id &&
					(event.data as StudioRun).status === "failed",
			);
			expect(failed.data).toMatchObject({ id: prompt.run.id, status: "failed" });

			const transcriptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/transcript`, {
				headers: { Cookie: cookie },
			});
			const transcript = (await transcriptResponse.json()) as StudioTranscriptResponse;
			expect(
				transcript.messages.map(message => ({ role: message.role, status: message.status, text: message.text })),
			).toEqual([
				{ role: "user", status: "completed", text: "This should fail later." },
				{ role: "assistant", status: "failed", text: "" },
			]);
		} finally {
			events.close();
		}
	});

	it("does not persist a ghost transcript when OMP rejects the prompt before acceptance", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-rejected-prompt");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const created = await createSession(studio, cookie, workspace.workspace.id);
		factory.transports[0].promptError = new Error("native prompt rejection");

		const rejected = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A, message: "This must not be retained." }),
		});
		expect(rejected.status).toBe(502);
		expect(await rejected.json()).toEqual({
			error: { code: "rpc_prompt_failed", message: "OMP could not accept the prompt." },
		});

		const transcriptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/transcript`, {
			headers: { Cookie: cookie },
		});
		const transcript = (await transcriptResponse.json()) as StudioTranscriptResponse;
		expect(transcript.messages).toEqual([]);
		const sessionResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}`, {
			headers: { Cookie: cookie },
		});
		expect(((await sessionResponse.json()) as StudioSessionResponse).session).toMatchObject({ status: "ready" });
	});

	it("returns a terminal session when OMP ends before prompt acceptance completes", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-terminal-before-acceptance");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const created = await createSession(studio, cookie, workspace.workspace.id);
		const transport = factory.transports[0];
		const promptGate = Promise.withResolvers<void>();
		transport.promptGate = promptGate.promise;

		const request = fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A, message: "Finish immediately." }),
		});
		await waitForCondition(() => transport.prompts.length === 1);
		transport.emit({ type: "agent_end" });
		promptGate.resolve();

		const accepted = await request;
		expect(accepted.status).toBe(202);
		const prompt = (await accepted.json()) as StudioPromptResponse;
		expect(prompt.run).toMatchObject({ status: "completed", studioSessionId: created.session.id });
		expect(prompt.session).toMatchObject({ id: created.session.id, status: "ready" });
		expect(prompt.session.activeRun).toBeUndefined();

		const sessionResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}`, {
			headers: { Cookie: cookie },
		});
		expect(((await sessionResponse.json()) as StudioSessionResponse).session.activeRun).toBeUndefined();
	});

	it("buffers early assistant snapshots and local-only results until OMP accepts the prompt", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-prompt-acceptance");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const created = await createSession(studio, cookie, workspace.workspace.id);
		const transport = factory.transports[0];
		const promptGate = Promise.withResolvers<void>();
		transport.promptGate = promptGate.promise;

		const request = fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
			body: JSON.stringify({ holderId: HOLDER_A, message: "Answer before acknowledgement." }),
		});
		await waitForCondition(() => transport.prompts.length === 1);
		transport.emitTranscript({ sourceId: "assistant_early", status: "streaming", text: "Early answer." });
		transport.emitPromptResult(false);

		const beforeAcceptance = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/transcript`, {
			headers: { Cookie: cookie },
		});
		expect(((await beforeAcceptance.json()) as StudioTranscriptResponse).messages).toEqual([]);

		promptGate.resolve();
		const accepted = await request;
		expect(accepted.status).toBe(202);
		const prompt = (await accepted.json()) as StudioPromptResponse;
		expect(prompt.run).toMatchObject({ status: "completed" });

		const transcriptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/transcript`, {
			headers: { Cookie: cookie },
		});
		const transcript = (await transcriptResponse.json()) as StudioTranscriptResponse;
		expect(
			transcript.messages.map(message => ({ role: message.role, status: message.status, text: message.text })),
		).toEqual([
			{ role: "user", status: "completed", text: "Answer before acknowledgement." },
			{ role: "assistant", status: "completed", text: "Early answer." },
		]);
	});

	it("settles local-only accepted prompts without leaving their run active", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-local-only");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "/local-command" }),
			});
			const prompt = (await promptResponse.json()) as StudioPromptResponse;
			factory.transports[0].emitPromptResult(false);
			const completed = await events.waitFor<StudioRun>(
				event =>
					event.type === "run.state" &&
					event.runId === prompt.run.id &&
					(event.data as StudioRun).status === "completed",
			);
			expect(completed.data).toMatchObject({ id: prompt.run.id, status: "completed" });

			const transcriptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/transcript`, {
				headers: { Cookie: cookie },
			});
			const transcript = (await transcriptResponse.json()) as StudioTranscriptResponse;
			expect(
				transcript.messages.map(message => ({ role: message.role, status: message.status, text: message.text })),
			).toEqual([
				{ role: "user", status: "completed", text: "/local-command" },
				{ role: "assistant", status: "completed", text: "" },
			]);
		} finally {
			events.close();
		}
	});

	it("marks an assistant provider error failed without forwarding its error details", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-agent-error");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "Request an answer." }),
			});
			const prompt = (await promptResponse.json()) as StudioPromptResponse;
			factory.transports[0].emitTranscript({ sourceId: "assistant_error", status: "failed", text: "" });
			factory.transports[0].emit({ isError: true, type: "agent_end" });
			const failed = await events.waitFor<StudioRun>(
				event =>
					event.type === "run.state" &&
					event.runId === prompt.run.id &&
					(event.data as StudioRun).status === "failed",
			);
			expect(failed.data).toMatchObject({ id: prompt.run.id, status: "failed" });

			const transcriptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/transcript`, {
				headers: { Cookie: cookie },
			});
			const transcript = (await transcriptResponse.json()) as StudioTranscriptResponse;
			expect(
				transcript.messages.map(message => ({ role: message.role, status: message.status, text: message.text })),
			).toEqual([
				{ role: "user", status: "completed", text: "Request an answer." },
				{ role: "assistant", status: "failed", text: "" },
			]);
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
			const runHistoryResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/runs`, {
				headers: { Cookie: cookie },
			});
			expect(runHistoryResponse.status).toBe(200);
			const runHistory = (await runHistoryResponse.json()) as StudioRunHistoryResponse;
			expect(runHistory.runs[0]).toMatchObject({ id: prompt.run.id, status: "running" });
			const usageHistoryResponse = await fetch(
				`${studio.origin}/api/v1/sessions/${created.session.id}/usage-history`,
				{ headers: { Cookie: cookie } },
			);
			expect(usageHistoryResponse.status).toBe(200);
			const usageHistory = (await usageHistoryResponse.json()) as StudioUsageHistoryResponse;
			expect(usageHistory.entries[0]).toMatchObject({
				runId: prompt.run.id,
				usage: { cost: 0.0123, totalTokens: 65 },
			});
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

describe("Studio browser-safe agent observability", () => {
	it("resolves a registered workspace server-side and returns only the safe change projection", async () => {
		const requestedWorkspacePaths: string[] = [];
		const changeReviewAdapter: StudioChangeReviewAdapter = {
			async getChangeSet({ workspacePath }) {
				requestedWorkspacePaths.push(workspacePath);
				return {
					additions: 1,
					deletions: 0,
					fileCount: 1,
					files: [
						{
							additions: 1,
							binary: false,
							deletions: 0,
							hunks: [
								{
									lines: [{ kind: "addition", text: "const visible = true;" }],
									newLineCount: 1,
									newStart: 1,
									oldLineCount: 0,
									oldStart: 0,
									truncated: false,
								},
							],
							path: "src/visible.ts",
							previewOmitted: false,
							previewTruncated: false,
							staged: false,
							status: "modified",
							untracked: false,
							unstaged: true,
						},
					],
					generatedAtMs: 123,
					stagedFileCount: 0,
					truncated: false,
					untrackedFileCount: 0,
					unstagedFileCount: 1,
				};
			},
		};
		const { root, studio } = await startTestStudio(changeReviewAdapter);
		const workspacePath = path.join(root, "workspace-change-review");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const created = await createSession(studio, cookie, workspace.workspace.id);

		const response = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/changes`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as StudioChangeSetResponse;
		expect(requestedWorkspacePaths).toEqual([workspacePath]);
		expect(body).toMatchObject({
			changeSet: {
				fileCount: 1,
				files: [{ path: "src/visible.ts" }],
			},
		});
		expect(JSON.stringify(body)).not.toContain(workspacePath);
		expect(JSON.stringify(body)).not.toContain("omp-session-alpha");
	});

	it("publishes fixed tool cards and plan totals without raw native tool or todo data", async () => {
		const { factory, root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-observability");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);
		const workspace = await registerWorkspace(studio, cookie, workspacePath);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const created = await createSession(studio, cookie, workspace.workspace.id);
			const promptResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/prompts`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ holderId: HOLDER_A, message: "inspect safe observability" }),
			});
			expect(promptResponse.status).toBe(202);
			const prompt = (await promptResponse.json()) as StudioPromptResponse;
			const transport = factory.transports[0];
			const rawToolStart = {
				args: { command: "type C:\\private\\credentials.txt", path: "C:\\private\\credentials.txt" },
				toolCallId: "native-tool-call-private",
				toolName: "write",
				type: "tool_execution_start",
			} as unknown as StudioRpcAgentEvent;
			transport.emit(rawToolStart);
			const started = await events.waitFor<StudioToolDisplay>(
				event => event.type === "tool.display_updated" && event.runId === prompt.run.id,
			);
			expect(started.data).toMatchObject({ kind: "file_write", status: "running" });
			expect(Object.keys(started.data).sort().join(",")).toBe(
				"id,kind,runId,startedAtMs,status,studioSessionId,updatedAtMs",
			);
			expect(JSON.stringify(started)).not.toContain("credentials.txt");
			expect(JSON.stringify(started)).not.toContain("native-tool-call-private");

			transport.emit({
				isError: true,
				result: { output: "replace this secret value" },
				toolCallId: "native-tool-call-private",
				toolName: "write",
				type: "tool_execution_end",
			} as unknown as StudioRpcAgentEvent);
			const ended = await events.waitFor<StudioToolDisplay>(
				event =>
					event.type === "tool.display_updated" &&
					(event.data as { status?: unknown }).status === "failed" &&
					event.runId === prompt.run.id,
			);
			expect(ended.data).toMatchObject({ id: started.data.id, status: "failed" });
			expect(JSON.stringify(ended)).not.toContain("replace this secret value");

			const toolCardsResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/tools`, {
				headers: { Cookie: cookie },
			});
			expect(toolCardsResponse.status).toBe(200);
			const toolCards = (await toolCardsResponse.json()) as StudioToolDisplayListResponse;
			expect(toolCards.cards).toEqual([ended.data]);

			const unsafePlan = {
				abandonedTaskCount: 1,
				blockedTaskCount: 1,
				completedTaskCount: 4,
				inProgressTaskCount: 2,
				pendingTaskCount: 3,
				taskText: "replace this secret value in C:\\private\\credentials.txt",
				totalTaskCount: 11,
			} as unknown as StudioRpcPlanSummary;
			transport.emitPlan(unsafePlan);
			const planEvent = await events.waitFor<StudioPlanSummary>(
				event => event.type === "plan.updated" && event.runId === prompt.run.id,
			);
			expect(planEvent.data).toMatchObject({ completedTaskCount: 4, totalTaskCount: 11 });
			expect(Object.keys(planEvent.data).sort().join(",")).toBe(
				"abandonedTaskCount,blockedTaskCount,completedTaskCount,inProgressTaskCount,pendingTaskCount,runId,studioSessionId,totalTaskCount,updatedAtMs",
			);
			expect(JSON.stringify(planEvent)).not.toContain("credentials.txt");
			expect(JSON.stringify(planEvent)).not.toContain("replace this secret value");

			const planResponse = await fetch(`${studio.origin}/api/v1/sessions/${created.session.id}/plan`, {
				headers: { Cookie: cookie },
			});
			expect(planResponse.status).toBe(200);
			const plan = (await planResponse.json()) as StudioPlanSummaryResponse;
			expect(plan.plan).toEqual(planEvent.data);
		} finally {
			events.close();
		}
	});
});
