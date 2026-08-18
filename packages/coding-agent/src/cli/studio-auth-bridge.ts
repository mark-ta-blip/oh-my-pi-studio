import {
	type StudioAuthBridge,
	StudioAuthBridgeError,
	type StudioAuthLoginCallbacks,
	type StudioCredentialOrigin,
	type StudioProvider,
	type StudioProviderModel,
} from "@oh-my-pi/omp-studio";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { ModelRegistry } from "../config/model-registry";
import { discoverAuthStorage } from "../session/auth-broker-config";
import type { AuthStorage, CredentialOrigin } from "../session/auth-storage";

interface ProviderEntry {
	canLogin: boolean;
	id: string;
	models: StudioProviderModel[];
	name: string;
}

function toStudioCredentialOrigin(origin: CredentialOrigin | undefined): StudioCredentialOrigin | undefined {
	return origin?.kind;
}

function toStudioModel(model: Model<Api>): StudioProviderModel {
	return {
		id: model.id,
		name: model.name,
		providerId: model.provider,
		reasoning: model.reasoning,
		supportsImageInput: model.input.includes("image"),
		supportsTools: model.supportsTools !== false,
		...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
		...(model.maxTokens === null ? {} : { maxTokens: model.maxTokens }),
	};
}

function sortProviders(left: StudioProvider, right: StudioProvider): number {
	return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/** Bridges the Studio server to the active OMP credential store and model registry. */
class OmpStudioAuthBridge implements StudioAuthBridge {
	#authStorage: AuthStorage;
	#closed = false;
	#modelRegistry: ModelRegistry;

	constructor(authStorage: AuthStorage, modelRegistry: ModelRegistry) {
		this.#authStorage = authStorage;
		this.#modelRegistry = modelRegistry;
	}

	async listProviders(): Promise<StudioProvider[]> {
		this.#assertOpen();
		await this.#authStorage.pollExternalChanges();
		const entries = new Map<string, ProviderEntry>();
		for (const provider of getOAuthProviders()) {
			const providerId = provider.storeCredentialsAs ?? provider.id;
			const entry = entries.get(providerId);
			if (entry) {
				entry.canLogin ||= provider.available;
				continue;
			}
			entries.set(providerId, {
				canLogin: provider.available,
				id: providerId,
				models: [],
				name: provider.name,
			});
		}

		for (const model of this.#modelRegistry.getAvailable()) {
			const providerId = model.provider;
			const entry = entries.get(providerId) ?? {
				canLogin: false,
				id: providerId,
				models: [],
				name: providerId,
			};
			entry.models.push(toStudioModel(model));
			entries.set(providerId, entry);
		}

		return [...entries.values()]
			.map(entry => {
				const origin = this.#authStorage.getCredentialOrigin(entry.id);
				const authenticated = this.#authStorage.hasAuth(entry.id);
				return {
					id: entry.id,
					name: entry.name,
					authState: authenticated ? "authenticated" : entry.models.length > 0 ? "keyless" : "unconfigured",
					...(authenticated && origin ? { credentialOrigin: toStudioCredentialOrigin(origin) } : {}),
					canLogin: entry.canLogin,
					models: entry.models.sort(
						(left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
					),
				} satisfies StudioProvider;
			})
			.sort(sortProviders);
	}

	async login(providerId: string, callbacks: StudioAuthLoginCallbacks): Promise<void> {
		this.#assertOpen();
		const candidates = getOAuthProviders().filter(
			candidate => candidate.id === providerId || candidate.storeCredentialsAs === providerId,
		);
		const provider =
			candidates.find(candidate => candidate.id === providerId && candidate.available) ??
			candidates.find(candidate => candidate.available) ??
			candidates.find(candidate => candidate.id === providerId) ??
			candidates[0];
		if (!provider) {
			throw new StudioAuthBridgeError("provider_not_found", "The requested OMP provider is not available.");
		}
		if (!provider.available) {
			throw new StudioAuthBridgeError(
				"provider_unavailable",
				"This provider is not available in the current OMP installation.",
			);
		}

		await this.#authStorage.login(provider.id, callbacks);
		const refreshTargets = new Set(
			[provider.id, provider.storeCredentialsAs].filter((value): value is string => value !== undefined),
		);
		for (const target of refreshTargets) {
			try {
				await this.#modelRegistry.refreshProvider(target, "online");
			} catch {
				logger.debug("Studio provider model refresh failed after login", { providerId: target });
			}
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#authStorage.close();
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new StudioAuthBridgeError(
				"auth_bridge_unavailable",
				"OMP provider onboarding is unavailable in this Studio host.",
			);
		}
	}
}

/** Create a bridge over the active profile's canonical OMP credential and model stores. */
export async function createStudioAuthBridge(): Promise<StudioAuthBridge> {
	const authStorage = await discoverAuthStorage();
	try {
		await authStorage.reload();
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.refresh("offline");
		return new OmpStudioAuthBridge(authStorage, modelRegistry);
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
