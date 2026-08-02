import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantVideos, ProviderVideos, VideosApi, VideosContext, VideosModel, VideosOptions } from "./types.ts";

export interface VideosProvider {
	readonly id: string;
	readonly name: string;
	readonly auth: ProviderAuth;
	getModels(): readonly VideosModel<VideosApi>[];
	refreshModels?(): Promise<void>;
	generateVideos(
		model: VideosModel<VideosApi>,
		context: VideosContext,
		options?: VideosOptions,
	): Promise<AssistantVideos>;
	queryVideoGeneration?(
		model: VideosModel<VideosApi>,
		taskId: string,
		options?: VideosOptions,
	): Promise<AssistantVideos>;
	downloadVideo?(model: VideosModel<VideosApi>, fileId: string, options?: VideosOptions): Promise<AssistantVideos>;
}

export interface VideosModels {
	getProviders(): readonly VideosProvider[];
	getProvider(id: string): VideosProvider | undefined;
	getModels(provider?: string): readonly VideosModel<VideosApi>[];
	getModel(provider: string, id: string): VideosModel<VideosApi> | undefined;
	refresh(provider?: string): Promise<void>;
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: VideosModel<VideosApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	generateVideos(
		model: VideosModel<VideosApi>,
		context: VideosContext,
		options?: VideosOptions,
	): Promise<AssistantVideos>;
}

export interface MutableVideosModels extends VideosModels {
	setProvider(provider: VideosProvider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

class VideosModelsImpl implements MutableVideosModels {
	private providers = new Map<string, VideosProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: VideosProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly VideosProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): VideosProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly VideosModel<VideosApi>[] {
		const entries = provider !== undefined ? [this.providers.get(provider)] : Array.from(this.providers.values());
		const models: VideosModel<VideosApi>[] = [];
		for (const entry of entries) {
			if (!entry) continue;
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): VideosModel<VideosApi> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(provider?: string): Promise<void> {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: VideosModel<VideosApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | VideosModel<VideosApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async generateVideos(
		model: VideosModel<VideosApi>,
		context: VideosContext,
		options?: VideosOptions,
	): Promise<AssistantVideos> {
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			const resolution = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env });
			const auth = resolution?.auth;
			if (!auth) return provider.generateVideos(model, context, options);
			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
			return await provider.generateVideos(requestModel, context, { ...options, apiKey, headers, env });
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	}
}

export function createVideosModels(options?: CreateModelsOptions): MutableVideosModels {
	return new VideosModelsImpl(options);
}

export interface CreateVideosProviderOptions {
	id: string;
	name?: string;
	auth: ProviderAuth;
	models: readonly VideosModel<VideosApi>[];
	refreshModels?: () => Promise<readonly VideosModel<VideosApi>[]>;
	api: ProviderVideos;
}

export function createVideosProvider(input: CreateVideosProviderOptions): VideosProvider {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;
	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		generateVideos: (model, context, options) => input.api.generateVideos(model, context, options),
		queryVideoGeneration: input.api.queryVideoGeneration
			? (model, taskId, options) =>
					input.api.queryVideoGeneration?.(model, taskId, options) as Promise<AssistantVideos>
			: undefined,
		downloadVideo: input.api.downloadVideo
			? (model, fileId, options) => input.api.downloadVideo?.(model, fileId, options) as Promise<AssistantVideos>
			: undefined,
	};
}
