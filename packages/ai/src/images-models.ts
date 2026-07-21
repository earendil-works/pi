import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions, ProviderImages } from "./types.ts";

/**
 * An image-generation provider: the image-side counterpart of `Provider`.
 * Owns id/name metadata, auth, model listing, and generation behavior.
 */
export interface ImagesProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * Required: at least one of `apiKey`/`oauth`. Same semantics as chat
	 * providers; `ImagesModels.getAuth()` returns undefined when the provider
	 * is unconfigured.
	 */
	readonly auth: ProviderAuth;

	/**
	 * Current known models, sync. Static providers return their catalog;
	 * dynamic providers return the list as of the last `refreshModels()`
	 * (empty before the first). Must not throw; `ImagesModels` treats a
	 * throwing implementation as having no models.
	 */
	getModels(): readonly ImagesModel<ImagesApi>[];

	/**
	 * Dynamic providers only: fetch and update the model list. May reject
	 * (network); on rejection the model list stays at its last-known state
	 * and a later call retries.
	 */
	refreshModels?(): Promise<void>;

	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * Runtime collection of image-generation providers plus auth application and
 * generation convenience: the image-side counterpart of `Models`.
 */
export interface ImagesModels {
	getProviders(): readonly ImagesProvider[];
	getProvider(id: string): ImagesProvider | undefined;

	/**
	 * Sync read of last-known models from one provider or all providers.
	 * Best-effort: a provider whose `getModels()` throws yields no models.
	 */
	getModels(provider?: string): readonly ImagesModel<ImagesApi>[];

	/** Sync runtime model lookup against last-known lists. */
	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;

	/**
	 * Ask dynamic providers to re-fetch their model lists. With a provider id,
	 * rejects with `ModelsError` ("model_source") on that provider's fetch
	 * failure; without one, refreshes all providers concurrently best-effort.
	 * Static providers (no `refreshModels`) are no-ops.
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * Resolve request auth by provider id or image model. Same contract as
	 * `Models.getAuth()`: undefined when unknown/unconfigured, rejects with
	 * `ModelsError` ("oauth"/"auth") on real failures.
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/**
	 * Generate images through the owning provider with auth resolved and
	 * merged (explicit options win per field). Never rejects; failures are
	 * returned as an `AssistantImages` with `stopReason: "error"`.
	 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface MutableImagesModels extends ImagesModels {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	setProvider(provider: ImagesProvider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

class ImagesModelsImpl implements MutableImagesModels {
	private providers = new Map<string, ImagesProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: ImagesProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly ImagesProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): ImagesProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: ImagesModel<ImagesApi>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined {
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

		// Cannot reject: the async mapper turns even sync throws from ill-behaved
		// providers into rejections, and allSettled captures all of them.
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | ImagesModel<ImagesApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages> {
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			const resolution = await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
			});
			const auth = resolution?.auth;
			if (!auth) {
				return provider.generateImages(model, context, options);
			}

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// Explicit request options win per-field; headers/env merge per key.
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			return await provider.generateImages(requestModel, context, { ...options, apiKey, headers, env });
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

export function createImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return new ImagesModelsImpl(options);
}

export interface CreateImagesProviderOptions {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	auth: ProviderAuth;
	/** Initial model list (empty for purely dynamic providers). */
	models: readonly ImagesModel<ImagesApi>[];
	/**
	 * Dynamic providers: fetch the current list. Stored on success; concurrent
	 * calls share one in-flight fetch. May reject: the stored list then stays
	 * at its last-known state, the rejection propagates to the caller of
	 * `refreshModels()` (wrapped as ModelsError "model_source" by
	 * `ImagesModels.refresh(provider)`), and a later call retries.
	 */
	refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
	api: ProviderImages;
}

/** Builds an image-generation provider from parts. */
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
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
		generateImages: (model, context, options) => input.api.generateImages(model, context, options),
	};
}
