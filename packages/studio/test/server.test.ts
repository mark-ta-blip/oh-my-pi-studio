import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { StudioAuthBridge, StudioAuthLoginCallbacks } from "../src/core/auth-bridge";
import {
	STUDIO_API_VERSION,
	type StudioAuthCancelResponse,
	type StudioAuthProgress,
	type StudioBootstrap,
	type StudioEventEnvelope,
	type StudioEventResyncRequired,
	type StudioProvider,
	type StudioProviderListResponse,
	type StudioProviderLoginResponse,
	type StudioWorkspaceResponse,
} from "../src/protocol";
import { type StudioServer, startStudioServer } from "../src/server";

const servers: StudioServer[] = [];
const tempDirs: string[] = [];
const EVENT_TIMEOUT_MS = 1_000;

type BunWebSocketConstructor = new (url: string, options: Bun.WebSocketOptions) => WebSocket;

const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

interface TestStudio {
	root: string;
	studio: StudioServer;
}

async function startTestStudio(root?: string, authBridge?: StudioAuthBridge): Promise<TestStudio> {
	const testRoot = root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-studio-test-")));
	if (root === undefined) tempDirs.push(testRoot);
	const studio = await startStudioServer({ authBridge, dbPath: path.join(testRoot, "studio.db"), port: 0 });
	servers.push(studio);
	return { root: testRoot, studio };
}

async function exchangeLocalAccess(studio: StudioServer): Promise<string> {
	const response = await fetch(studio.url, { redirect: "manual" });
	expect(response.status).toBe(302);
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie) throw new Error("Studio local access exchange did not set a cookie");
	return cookie;
}

function eventsUrl(origin: string, afterSequence?: number): string {
	const url = new URL(`${origin.replace(/^http:/, "ws:")}/api/v1/events`);
	if (afterSequence !== undefined) url.searchParams.set("after", String(afterSequence));
	return url.toString();
}

function receiveStudioReadyEvent(studio: StudioServer, cookie: string): Promise<StudioEventEnvelope<StudioBootstrap>> {
	const socket = new BunWebSocket(eventsUrl(studio.origin), {
		headers: { Cookie: cookie, Origin: studio.origin },
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
			cleanup();
			resolve(envelope);
		} catch (error) {
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	};
	const onError = (): void => {
		cleanup();
		reject(new Error("Studio events did not connect"));
	};
	timeout = setTimeout(() => {
		cleanup();
		reject(new Error("Studio events did not emit studio.ready"));
	}, EVENT_TIMEOUT_MS);
	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	return promise;
}

interface StudioEventSubscription {
	close(): void;
	waitFor<TData>(predicate: (event: StudioEventEnvelope<unknown>) => boolean): Promise<StudioEventEnvelope<TData>>;
}

async function subscribeStudioEvents(
	studio: StudioServer,
	cookie: string,
	afterSequence?: number,
): Promise<StudioEventSubscription> {
	const socket = new BunWebSocket(eventsUrl(studio.origin, afterSequence), {
		headers: { Cookie: cookie, Origin: studio.origin },
	});
	const events: StudioEventEnvelope<unknown>[] = [];
	const waiters: Array<{
		predicate: (event: StudioEventEnvelope<unknown>) => boolean;
		reject(error: Error): void;
		resolve(event: StudioEventEnvelope<unknown>): void;
	}> = [];
	let closed = false;
	const rejectWaiters = (error: Error): void => {
		for (const waiter of waiters.splice(0)) waiter.reject(error);
	};
	const subscription: StudioEventSubscription = {
		close: () => {
			if (closed) return;
			closed = true;
			rejectWaiters(new Error("Studio event subscription closed"));
			if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000);
		},
		waitFor: <TData>(
			predicate: (event: StudioEventEnvelope<unknown>) => boolean,
		): Promise<StudioEventEnvelope<TData>> => {
			const existing = events.find(predicate);
			if (existing) return Promise.resolve(existing as StudioEventEnvelope<TData>);
			const { promise, resolve, reject } = Promise.withResolvers<StudioEventEnvelope<TData>>();
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
					resolve(event as StudioEventEnvelope<TData>);
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
			rejectWaiters(error instanceof Error ? error : new Error(String(error)));
		}
	});
	socket.addEventListener("error", () => rejectWaiters(new Error("Studio events did not connect")));
	socket.addEventListener("close", () => {
		if (!closed) rejectWaiters(new Error("Studio events closed unexpectedly"));
	});
	await subscription.waitFor<StudioBootstrap>(event => event.type === "studio.ready");
	return subscription;
}

class FakeStudioAuthBridge implements StudioAuthBridge {
	callbacks: StudioAuthLoginCallbacks | undefined;
	closed = false;

	async listProviders(): Promise<StudioProvider[]> {
		return [
			{
				id: "example",
				name: "Example provider",
				authState: "unconfigured",
				canLogin: true,
				models: [
					{
						id: "example-model",
						name: "Example Model",
						providerId: "example",
						reasoning: true,
						supportsImageInput: false,
						supportsTools: true,
					},
				],
			},
		];
	}

	async login(providerId: string, callbacks: StudioAuthLoginCallbacks): Promise<void> {
		if (providerId !== "example") throw new Error("unexpected provider");
		this.callbacks = callbacks;
		callbacks.onAuth({ url: "https://login.example.test/authorize?state=opaque" });
		callbacks.onProgress("Waiting for the provider response.");
		const credential = await callbacks.onPrompt({ message: "Enter API key", placeholder: "example-key" });
		throw new Error(`Provider rejected ${credential}`);
	}

	close(): void {
		this.closed = true;
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
	for (const server of servers.splice(0)) server.stop();
	await Promise.all(tempDirs.splice(0).map(removeTestTempDir));
});

describe("Studio local access boundary", () => {
	it("exchanges a one-time local URL for the cookie that unlocks the client and bootstrap API", async () => {
		const { studio } = await startTestStudio();

		const blocked = await fetch(`${studio.origin}/api/v1/bootstrap`);
		expect(blocked.status).toBe(401);
		expect(await blocked.json()).toEqual({
			error: {
				code: "local_access_required",
				message: "Open Studio using its one-time local URL.",
			},
		});

		const cookie = await exchangeLocalAccess(studio);
		const urlToken = new URL(studio.url).searchParams.get("token");
		expect(cookie).not.toBe(`omp_studio_session=${urlToken}`);
		const replay = await fetch(studio.url, { redirect: "manual" });
		expect(replay.status).toBe(401);

		const [client, bootstrap] = await Promise.all([
			fetch(`${studio.origin}/`, { headers: { Cookie: cookie } }),
			fetch(`${studio.origin}/api/v1/bootstrap`, { headers: { Cookie: cookie } }),
		]);
		expect(client.status).toBe(200);
		expect(await client.text()).toContain('<div id="root"></div>');
		expect(bootstrap.status).toBe(200);
		const bootstrapPayload = (await bootstrap.json()) as StudioBootstrap;
		expect(bootstrapPayload).toMatchObject({
			apiVersion: 1,
			mode: "local-single-user",
			runtimeVersion: expect.any(String),
			features: {
				localAccess: true,
				webSocketEvents: true,
				workspaceRegistry: true,
			},
		});

		const ready = await receiveStudioReadyEvent(studio, cookie);
		expect(ready).toMatchObject({
			version: STUDIO_API_VERSION,
			sequence: 0,
			type: "studio.ready",
			data: {
				apiVersion: STUDIO_API_VERSION,
				profile: bootstrapPayload.profile,
			},
		});
	});

	it("replays cursor-backed events and requests REST resync after the bounded history expires", async () => {
		const bridge = new FakeStudioAuthBridge();
		const { studio } = await startTestStudio(undefined, bridge);
		const cookie = await exchangeLocalAccess(studio);
		const initial = await subscribeStudioEvents(studio, cookie);
		try {
			const started = await fetch(`${studio.origin}/api/v1/providers/example/login`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: studio.origin },
			});
			expect(started.status).toBe(202);
			const authorization = await initial.waitFor<StudioAuthProgress>(
				event => event.type === "auth.progress" && (event.data as StudioAuthProgress).phase === "authorization",
			);
			initial.close();

			bridge.callbacks?.onProgress("progress emitted while the browser was disconnected");
			const replay = await subscribeStudioEvents(studio, cookie, authorization.sequence);
			try {
				const replayed = await replay.waitFor<StudioAuthProgress>(
					event =>
						event.type === "auth.progress" &&
						(event.data as StudioAuthProgress).message === "progress emitted while the browser was disconnected",
				);
				expect(replayed.sequence).toBeGreaterThan(authorization.sequence);
			} finally {
				replay.close();
			}

			for (let index = 0; index < 300; index += 1) bridge.callbacks?.onProgress(`replay buffer ${index}`);
			const stale = await subscribeStudioEvents(studio, cookie, authorization.sequence);
			try {
				const resync = await stale.waitFor<StudioEventResyncRequired>(
					event => event.type === "studio.resync_required",
				);
				expect(resync.data).toMatchObject({
					afterSequence: authorization.sequence,
					latestSequence: expect.any(Number),
				});
				expect((resync.data as StudioEventResyncRequired).earliestAvailableSequence).toBeGreaterThan(
					authorization.sequence,
				);
			} finally {
				stale.close();
			}
		} finally {
			initial.close();
		}
	});
	it("closes a connected event socket when the server stops", async () => {
		const { studio } = await startTestStudio();
		const cookie = await exchangeLocalAccess(studio);
		const socket = new BunWebSocket(eventsUrl(studio.origin), {
			headers: { Cookie: cookie, Origin: studio.origin },
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("Studio event socket did not open")));
		});
		const closed = new Promise<void>((resolve, reject) => {
			socket.addEventListener("close", () => resolve());
			const timer = setTimeout(() => reject(new Error("Studio event socket stayed open after stop")), 2_000);
			timer.unref();
		});

		studio.stop();

		// A drain would never finish: an idle tab holds this socket open for as
		// long as it is on screen, so the process would outlive its own shutdown.
		await closed;
	});
});

describe("Studio provider onboarding", () => {
	it("cancels an unfinished provider sign-in and lets the user retry immediately", async () => {
		const bridge = new FakeStudioAuthBridge();
		const { studio } = await startTestStudio(undefined, bridge);
		const cookie = await exchangeLocalAccess(studio);
		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const started = await fetch(`${studio.origin}/api/v1/providers/example/login`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: studio.origin },
			});
			expect(started.status).toBe(202);
			const login = (await started.json()) as StudioProviderLoginResponse;
			await events.waitFor<StudioAuthProgress>(
				event =>
					event.type === "auth.progress" &&
					(event.data as StudioAuthProgress).flowId === login.flowId &&
					(event.data as StudioAuthProgress).phase === "prompt",
			);

			const cancelled = await fetch(`${studio.origin}/api/v1/auth/cancel`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ flowId: login.flowId }),
			});
			expect(cancelled.status).toBe(202);
			expect((await cancelled.json()) as StudioAuthCancelResponse).toEqual({
				flowId: login.flowId,
				cancelled: true,
			});
			const cancellation = await events.waitFor<StudioAuthProgress>(
				event =>
					event.type === "auth.progress" &&
					(event.data as StudioAuthProgress).flowId === login.flowId &&
					(event.data as StudioAuthProgress).phase === "cancelled",
			);
			expect(cancellation.data).toMatchObject({
				flowId: login.flowId,
				phase: "cancelled",
			});
			expect(bridge.callbacks?.signal.aborted).toBe(true);

			const retry = await fetch(`${studio.origin}/api/v1/providers/example/login`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: studio.origin },
			});
			expect(retry.status).toBe(202);
		} finally {
			events.close();
		}
	});

	it("relays native auth steps while keeping a submitted credential out of API and event output", async () => {
		const bridge = new FakeStudioAuthBridge();
		const { studio } = await startTestStudio(undefined, bridge);
		const cookie = await exchangeLocalAccess(studio);
		const bootstrap = await fetch(`${studio.origin}/api/v1/bootstrap`, { headers: { Cookie: cookie } });
		expect((await bootstrap.json()) as StudioBootstrap).toMatchObject({
			features: { providerOnboarding: true },
		});

		const listed = await fetch(`${studio.origin}/api/v1/providers`, { headers: { Cookie: cookie } });
		expect(listed.status).toBe(200);
		expect((await listed.json()) as StudioProviderListResponse).toEqual({
			providers: [
				{
					id: "example",
					name: "Example provider",
					authState: "unconfigured",
					canLogin: true,
					models: [
						{
							id: "example-model",
							name: "Example Model",
							providerId: "example",
							reasoning: true,
							supportsImageInput: false,
							supportsTools: true,
						},
					],
				},
			],
		});

		const events = await subscribeStudioEvents(studio, cookie);
		try {
			const started = await fetch(`${studio.origin}/api/v1/providers/example/login`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: studio.origin },
			});
			expect(started.status).toBe(202);
			const login = (await started.json()) as StudioProviderLoginResponse;
			expect(login).toEqual({ flowId: expect.stringMatching(/^ath_[a-f0-9]{32}$/), providerId: "example" });

			const authorization = await events.waitFor<StudioAuthProgress>(
				event => event.type === "auth.progress" && (event.data as StudioAuthProgress).phase === "authorization",
			);
			expect(authorization.data).toMatchObject({
				flowId: login.flowId,
				providerId: "example",
				phase: "authorization",
				authorizationUrl: "https://login.example.test/authorize?state=opaque",
			});
			const prompt = await events.waitFor<StudioAuthProgress>(
				event => event.type === "auth.progress" && (event.data as StudioAuthProgress).phase === "prompt",
			);
			expect(prompt.data).toMatchObject({
				flowId: login.flowId,
				phase: "prompt",
				prompt: { message: "Enter API key", placeholder: "example-key", allowEmpty: false },
			});

			const forged = await fetch(`${studio.origin}/api/v1/auth/continue`, {
				method: "POST",
				headers: {
					Cookie: cookie,
					"Content-Type": "application/json",
					Origin: "http://127.0.0.1:1",
				},
				body: JSON.stringify({ flowId: login.flowId, value: "studio-test-secret" }),
			});
			expect(forged.status).toBe(403);
			expect(bridge.callbacks).toBeDefined();

			const continued = await fetch(`${studio.origin}/api/v1/auth/continue`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json", Origin: studio.origin },
				body: JSON.stringify({ flowId: login.flowId, value: "studio-test-secret" }),
			});
			expect(continued.status).toBe(202);
			expect(await continued.json()).toEqual({ flowId: login.flowId, accepted: true });

			const failed = await events.waitFor<StudioAuthProgress>(
				event => event.type === "auth.progress" && (event.data as StudioAuthProgress).phase === "failed",
			);
			expect(JSON.stringify(failed)).not.toContain("studio-test-secret");
			expect(failed.data).toMatchObject({
				flowId: login.flowId,
				phase: "failed",
				message: "Provider sign-in did not complete. Check the provider page or try again.",
			});
		} finally {
			events.close();
		}
	});
});

describe("Studio workspace registry", () => {
	it("registers a canonical directory behind opaque metadata and rejects a forged mutation origin", async () => {
		const { root, studio } = await startTestStudio();
		const workspacePath = path.join(root, "workspace-alpha");
		await fs.mkdir(workspacePath);
		const cookie = await exchangeLocalAccess(studio);

		const created = await fetch(`${studio.origin}/api/v1/workspaces`, {
			method: "POST",
			headers: {
				Cookie: cookie,
				"Content-Type": "application/json",
				Origin: studio.origin,
			},
			body: JSON.stringify({ label: "Alpha workspace", path: path.join(workspacePath, ".") }),
		});
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as StudioWorkspaceResponse;
		expect(createdBody.workspace).toEqual({
			id: expect.stringMatching(/^wsp_[a-f0-9]{32}$/),
			label: "Alpha workspace",
			createdAtMs: expect.any(Number),
			updatedAtMs: expect.any(Number),
		});

		const duplicate = await fetch(`${studio.origin}/api/v1/workspaces`, {
			method: "POST",
			headers: {
				Cookie: cookie,
				"Content-Type": "application/json",
				Origin: studio.origin,
			},
			body: JSON.stringify({ path: workspacePath }),
		});
		expect(duplicate.status).toBe(200);
		expect((await duplicate.json()) as StudioWorkspaceResponse).toEqual({ workspace: createdBody.workspace });

		const listed = await fetch(`${studio.origin}/api/v1/workspaces`, { headers: { Cookie: cookie } });
		expect(listed.status).toBe(200);
		expect(await listed.json()).toEqual({ workspaces: [createdBody.workspace] });

		const forged = await fetch(`${studio.origin}/api/v1/workspaces`, {
			method: "POST",
			headers: {
				Cookie: cookie,
				"Content-Type": "application/json",
				Origin: "http://127.0.0.1:1",
			},
			body: JSON.stringify({ path: workspacePath }),
		});
		expect(forged.status).toBe(403);
		expect(await forged.json()).toEqual({
			error: { code: "origin_not_allowed", message: "The Studio request origin is not allowed." },
		});

		const deleted = await fetch(`${studio.origin}/api/v1/workspaces/${createdBody.workspace.id}`, {
			method: "DELETE",
			headers: { Cookie: cookie, Origin: studio.origin },
		});
		expect(deleted.status).toBe(204);
		const empty = await fetch(`${studio.origin}/api/v1/workspaces`, { headers: { Cookie: cookie } });
		expect(await empty.json()).toEqual({ workspaces: [] });
	});

	it("keeps registered workspace IDs across a Studio restart without exposing their paths", async () => {
		const first = await startTestStudio();
		const workspacePath = path.join(first.root, "workspace-persisted");
		await fs.mkdir(workspacePath);
		const firstCookie = await exchangeLocalAccess(first.studio);
		const registration = await fetch(`${first.studio.origin}/api/v1/workspaces`, {
			method: "POST",
			headers: {
				Cookie: firstCookie,
				"Content-Type": "application/json",
				Origin: first.studio.origin,
			},
			body: JSON.stringify({ path: workspacePath }),
		});
		const registered = (await registration.json()) as StudioWorkspaceResponse;
		expect(registration.status).toBe(201);
		first.studio.stop();

		const second = await startTestStudio(first.root);
		const secondCookie = await exchangeLocalAccess(second.studio);
		const listed = await fetch(`${second.studio.origin}/api/v1/workspaces`, { headers: { Cookie: secondCookie } });
		expect(await listed.json()).toEqual({ workspaces: [registered.workspace] });
	});
});
