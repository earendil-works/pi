import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantMusic, MusicApi, MusicContext, MusicModel, MusicOptions, ProviderMusic } from "./types.ts";

/**
 * A music-generation provider: the music-side counterpart of `ImagesProvider`.
 * Owns id/name metadata, auth, model listing, and generation behavior.
 */
export interface MusicProvider {
	readonly id: string;
	readonly name: string;

	/** Required: at least one of `apiKey`/`oauth`. */
	readonly auth: ProviderAuth;

	/** Current known models, sync. Must not throw. */
	getModels(): readonly MusicModel<MusicApi>[];

	generateMusic(model: MusicModel<MusicApi>, context: MusicContext, options?: MusicOptions): Promise<AssistantMusic>;
}

/**
 * Runtime collection of music-generation providers plus auth application and
 * generation convenience: the music-side counterpart of `ImagesModels`.
 */
export interface MusicModels {
	getProviders(): readonly MusicProvider[];
	getProvider(id: string): MusicProvider | undefined;
	getModels(provider?: string): readonly MusicModel<MusicApi>[];
	getModel(provider: string, id: string): MusicModel<MusicApi> | undefined;
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: MusicModel<MusicApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	/**
	 * Generate music through the owning provider with auth resolved and merged
	 * (explicit options win per field). Never rejects; failures are returned as
	 * an `AssistantMusic` with `stopReason: "error"`.
	 */
	generateMusic(model: MusicModel<MusicApi>, context: MusicContext, options?: MusicOptions): Promise<AssistantMusic>;
}

export interface MutableMusicModels extends MusicModels {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	setProvider(provider: MusicProvider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

class MusicModelsImpl implements MutableMusicModels {
	private providers = new Map<string, MusicProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: MusicProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly MusicProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): MusicProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly MusicModel<MusicApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: MusicModel<MusicApi>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): MusicModel<MusicApi> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: MusicModel<MusicApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | MusicModel<MusicApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async generateMusic(
		model: MusicModel<MusicApi>,
		context: MusicContext,
		options?: MusicOptions,
	): Promise<AssistantMusic> {
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			const resolution = await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
				signal: options?.signal,
			});
			const auth = resolution?.auth;
			if (!auth) {
				return provider.generateMusic(model, context, options);
			}

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// Explicit request options win per-field; headers/env merge per key.
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			return await provider.generateMusic(requestModel, context, { ...options, apiKey, headers, env });
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

export function createMusicModels(options?: CreateModelsOptions): MutableMusicModels {
	return new MusicModelsImpl(options);
}

export interface CreateMusicProviderOptions {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	auth: ProviderAuth;
	/** Initial model list. */
	models: readonly MusicModel<MusicApi>[];
	api: ProviderMusic;
}

/** Builds a music-generation provider from parts. */
export function createMusicProvider(input: CreateMusicProviderOptions): MusicProvider {
	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => input.models,
		generateMusic: (model, context, options) => input.api.generateMusic(model, context, options),
	};
}
