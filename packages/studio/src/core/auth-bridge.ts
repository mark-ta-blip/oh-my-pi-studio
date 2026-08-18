import type { StudioAuthProgress, StudioAuthPrompt, StudioProvider, StudioProviderLoginResponse } from "../protocol";

const AUTH_FLOW_ID_PATTERN = /^ath_[a-f0-9]{32}$/;
const MAX_AUTH_CONTINUATION_LENGTH = 16_384;
const MAX_AUTH_TEXT_LENGTH = 1_024;

export type StudioAuthBridgeErrorCode =
	| "auth_bridge_unavailable"
	| "provider_not_found"
	| "provider_unavailable"
	| "auth_flow_active"
	| "auth_flow_not_found"
	| "auth_flow_not_waiting"
	| "invalid_auth_continuation"
	| "invalid_auth_cancellation";

/** A known-safe failure that can be returned as a Studio REST error. */
export class StudioAuthBridgeError extends Error {
	constructor(
		readonly code: StudioAuthBridgeErrorCode,
		message: string,
	) {
		super(message);
		this.name = "StudioAuthBridgeError";
	}
}

/** OMP-native login callbacks. The bridge owns credential persistence; Studio only brokers UI steps. */
export interface StudioAuthLoginCallbacks {
	signal: AbortSignal;
	onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
	onProgress(message: string): void;
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
}

/** Implemented by coding-agent so Studio never imports the package that depends on it. */
export interface StudioAuthBridge {
	listProviders(): Promise<StudioProvider[]>;
	login(providerId: string, callbacks: StudioAuthLoginCallbacks): Promise<void>;
	close(): void;
}

interface PendingAuthPrompt {
	allowEmpty: boolean;
	resolve(value: string): void;
}

interface ActiveAuthFlow {
	abort: AbortController;
	id: string;
	pendingPrompt?: PendingAuthPrompt;
	providerId: string;
	sensitiveValues: string[];
}

function createAuthFlowId(): string {
	return `ath_${crypto.randomUUID().replaceAll("-", "")}`;
}

function sanitizeText(value: string, sensitiveValues: readonly string[]): string {
	let result = value.replace(/[\u0000-\u001f\u007f]/g, " ");
	for (const sensitive of sensitiveValues) {
		if (sensitive.length > 0) result = result.replaceAll(sensitive, "[redacted]");
	}
	result = result
		.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
		.replace(/((?:api[_ -]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
	return result.trim().slice(0, MAX_AUTH_TEXT_LENGTH);
}

function sanitizeUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Coordinates exactly one in-memory, browser-assisted OMP authentication flow at a time. */
export class StudioAuthFlowCoordinator {
	#activeFlow: ActiveAuthFlow | undefined;
	#bridge: StudioAuthBridge | undefined;
	#publish: (progress: StudioAuthProgress) => void;

	constructor(bridge: StudioAuthBridge | undefined, publish: (progress: StudioAuthProgress) => void) {
		this.#bridge = bridge;
		this.#publish = publish;
	}

	get enabled(): boolean {
		return this.#bridge !== undefined;
	}

	async listProviders(): Promise<StudioProvider[]> {
		if (!this.#bridge) {
			throw new StudioAuthBridgeError(
				"auth_bridge_unavailable",
				"OMP provider onboarding is unavailable in this Studio host.",
			);
		}
		return await this.#bridge.listProviders();
	}

	async start(providerId: string): Promise<StudioProviderLoginResponse> {
		if (!this.#bridge) {
			throw new StudioAuthBridgeError(
				"auth_bridge_unavailable",
				"OMP provider onboarding is unavailable in this Studio host.",
			);
		}
		if (this.#activeFlow) {
			throw new StudioAuthBridgeError(
				"auth_flow_active",
				"Finish or cancel the current provider sign-in before starting another one.",
			);
		}
		const provider = (await this.#bridge.listProviders()).find(candidate => candidate.id === providerId);
		if (!provider) {
			throw new StudioAuthBridgeError("provider_not_found", "The requested OMP provider is not available.");
		}
		if (!provider.canLogin) {
			throw new StudioAuthBridgeError("provider_unavailable", "This provider cannot be connected through Studio.");
		}
		const flow: ActiveAuthFlow = {
			abort: new AbortController(),
			id: createAuthFlowId(),
			providerId,
			sensitiveValues: [],
		};
		this.#activeFlow = flow;
		void this.#run(flow);
		return { flowId: flow.id, providerId };
	}

	continue(flowId: string, value: string): void {
		if (!AUTH_FLOW_ID_PATTERN.test(flowId)) {
			throw new StudioAuthBridgeError("invalid_auth_continuation", "The authentication flow identifier is invalid.");
		}
		if (value.length > MAX_AUTH_CONTINUATION_LENGTH) {
			throw new StudioAuthBridgeError("invalid_auth_continuation", "The authentication response is too long.");
		}
		const flow = this.#activeFlow;
		if (!flow || flow.id !== flowId) {
			throw new StudioAuthBridgeError("auth_flow_not_found", "The authentication flow is no longer active.");
		}
		const prompt = flow.pendingPrompt;
		if (!prompt) {
			throw new StudioAuthBridgeError("auth_flow_not_waiting", "The provider is not waiting for a response.");
		}
		if (!prompt.allowEmpty && value.length === 0) {
			throw new StudioAuthBridgeError("invalid_auth_continuation", "The provider requires a response.");
		}
		flow.pendingPrompt = undefined;
		if (value.length > 0) flow.sensitiveValues.push(value);
		prompt.resolve(value);
	}

	cancel(flowId: string): void {
		if (!AUTH_FLOW_ID_PATTERN.test(flowId)) {
			throw new StudioAuthBridgeError("invalid_auth_cancellation", "The authentication flow identifier is invalid.");
		}
		const flow = this.#activeFlow;
		if (!flow || flow.id !== flowId) {
			throw new StudioAuthBridgeError("auth_flow_not_found", "The authentication flow is no longer active.");
		}
		this.#activeFlow = undefined;
		flow.abort.abort();
		flow.sensitiveValues.splice(0);
		this.#publish({
			flowId: flow.id,
			providerId: flow.providerId,
			phase: "cancelled",
			message: "Provider sign-in was cancelled.",
		});
	}

	close(): void {
		const flow = this.#activeFlow;
		this.#activeFlow = undefined;
		flow?.abort.abort();
		flow?.sensitiveValues.splice(0);
		this.#bridge?.close();
	}

	async #run(flow: ActiveAuthFlow): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge) return;
		try {
			await bridge.login(flow.providerId, {
				signal: flow.abort.signal,
				onAuth: info => {
					const authorizationUrl = sanitizeUrl(info.url);
					const launchUrl = sanitizeUrl(info.launchUrl);
					this.#publish({
						flowId: flow.id,
						providerId: flow.providerId,
						phase: "authorization",
						...(authorizationUrl ? { authorizationUrl } : {}),
						...(launchUrl ? { launchUrl } : {}),
						...(info.instructions ? { instructions: sanitizeText(info.instructions, flow.sensitiveValues) } : {}),
					});
				},
				onProgress: message => {
					this.#publish({
						flowId: flow.id,
						providerId: flow.providerId,
						phase: "progress",
						message: sanitizeText(message, flow.sensitiveValues),
					});
				},
				onPrompt: prompt => this.#waitForPrompt(flow, prompt),
			});
			if (this.#activeFlow !== flow) return;
			this.#publish({ flowId: flow.id, providerId: flow.providerId, phase: "completed" });
		} catch (error) {
			if (this.#activeFlow !== flow) return;
			const cancelled = flow.abort.signal.aborted;
			this.#publish({
				flowId: flow.id,
				providerId: flow.providerId,
				phase: cancelled ? "cancelled" : "failed",
				message: cancelled
					? "Provider sign-in was cancelled."
					: error instanceof StudioAuthBridgeError
						? sanitizeText(error.message, flow.sensitiveValues)
						: "Provider sign-in did not complete. Check the provider page or try again.",
			});
		} finally {
			if (this.#activeFlow === flow) this.#activeFlow = undefined;
			flow.sensitiveValues.splice(0);
		}
	}

	#waitForPrompt(
		flow: ActiveAuthFlow,
		prompt: Omit<StudioAuthPrompt, "allowEmpty"> & { allowEmpty?: boolean },
	): Promise<string> {
		if (flow.abort.signal.aborted) return Promise.reject(flow.abort.signal.reason);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const abort = (): void => reject(flow.abort.signal.reason ?? new Error("Provider sign-in was cancelled."));
		flow.abort.signal.addEventListener("abort", abort, { once: true });
		const allowEmpty = prompt.allowEmpty ?? false;
		flow.pendingPrompt = {
			allowEmpty,
			resolve: value => {
				flow.abort.signal.removeEventListener("abort", abort);
				resolve(value);
			},
		};
		this.#publish({
			flowId: flow.id,
			providerId: flow.providerId,
			phase: "prompt",
			prompt: {
				message: sanitizeText(prompt.message, flow.sensitiveValues),
				...(prompt.placeholder ? { placeholder: sanitizeText(prompt.placeholder, flow.sensitiveValues) } : {}),
				allowEmpty,
			},
		});
		return promise;
	}
}
