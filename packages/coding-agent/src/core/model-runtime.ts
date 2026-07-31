import { dirname, join } from "node:path";
import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelsStreamTransforms,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "../config.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedCredentialTypes: ReadonlyMap<string, Credential["type"]>;
	runtimeProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

interface RegistrationSources {
	native: ReadonlyMap<string, Provider>;
	extensions: ReadonlyMap<string, ProviderConfigInput>;
	revision: number;
}

interface ComposedModels {
	models: MutableModels;
	compositionErrors: ReadonlyMap<string, string>;
}

interface PublishedState {
	models: MutableModels;
	config: ModelConfig;
	extensions: ReadonlyMap<string, ProviderConfigInput>;
	compositionErrors: ReadonlyMap<string, string>;
	snapshot: ModelRuntimeSnapshot;
}

interface ConvergenceState {
	target: number;
	scheduled: boolean;
	progress: number;
	suppressedAt: number;
	error?: string;
}

interface AvailabilityReadState {
	reads: WeakMap<PublishedState, Promise<readonly Model<Api>[]>>;
	error?: string;
}

interface TransactionResult<T> {
	refresh: ModelsRefreshResult;
	value: T;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
}

export interface ModelRuntimeAuthOverrides {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function supportsCredentialType(provider: Provider, type: Credential["type"]): boolean {
	return type === "api_key" ? provider.auth.apiKey !== undefined : provider.auth.oauth !== undefined;
}

function abortedResult(): ModelsRefreshResult {
	return { aborted: true, errors: new Map() };
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly credentials: RuntimeCredentials;
	private readonly modelsStore: ModelsStore;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private published: PublishedState;
	private sourceRevision = 0;
	private transactionTail: Promise<void> = Promise.resolve();
	private readonly convergence: ConvergenceState = {
		target: 0,
		scheduled: false,
		progress: 0,
		suppressedAt: 0,
	};
	private readonly availability: AvailabilityReadState = { reads: new WeakMap() };

	private get models(): MutableModels {
		return this.published.models;
	}

	private get config(): ModelConfig {
		return this.published.config;
	}

	private get snapshot(): ModelRuntimeSnapshot {
		return this.published.snapshot;
	}

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.modelsStore = modelsStore;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		const initialSources = this.captureSources();
		const composed = this.composeModels(config, initialSources);
		const models = this.materializeModels(composed.models, initialSources);
		const all = [...models.getModels()];
		this.published = {
			models,
			config,
			extensions: new Map(),
			compositionErrors: composed.compositionErrors,
			snapshot: {
				all,
				available: [],
				configuredProviders: new Set(),
				storedCredentialTypes: new Map(),
				runtimeProviders: new Set(),
				auth: new Map(),
			},
		};
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.id === "radius"
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			process.env.PI_OFFLINE === undefined,
		);
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller = refreshFromNetwork ? new AbortController() : undefined;
		const timeout = controller
			? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs ?? 15_000)
			: undefined;
		try {
			await runtime.refresh({ allowNetwork: refreshFromNetwork, signal: controller?.signal });
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	private captureSources(): RegistrationSources {
		return {
			native: new Map(this.nativeExtensionProviders),
			extensions: new Map(this.extensionProviders),
			revision: this.sourceRevision,
		};
	}

	private configuredBuiltins(config: ModelConfig): Map<string, Provider> {
		const builtins = new Map(this.defaultBuiltins);
		for (const providerId of config.getProviderIds()) {
			const providerConfig = config.getProvider(providerId);
			if (providerConfig?.oauth !== "radius" || !providerConfig.baseUrl) continue;
			builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: providerConfig.name ?? providerId,
					gateway: providerConfig.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
		return builtins;
	}

	private composeModels(
		config: ModelConfig,
		sources: RegistrationSources,
		credentials: CredentialStore = this.credentials,
	): ComposedModels {
		const models = createModels({ credentials, modelsStore: this.modelsStore });
		const errors = new Map<string, string>();
		const builtins = this.configuredBuiltins(config);
		const providerIds = new Set([
			...builtins.keys(),
			...sources.native.keys(),
			...config.getProviderIds(),
			...sources.extensions.keys(),
		]);
		for (const providerId of providerIds) {
			const base = sources.native.get(providerId) ?? builtins.get(providerId);
			const extension = sources.extensions.get(providerId);
			if (base && !config.getProvider(providerId) && !extension) {
				models.setProvider(base);
				continue;
			}
			try {
				models.setProvider(composeModelProvider(providerId, base, config, extension));
			} catch (error) {
				errors.set(providerId, errorMessage(error));
				if (base) models.setProvider(base);
			}
		}
		return { models, compositionErrors: errors };
	}

	private materializeModels(working: Models, sources: RegistrationSources): MutableModels {
		const stable = createModels({ credentials: this.credentials, modelsStore: this.modelsStore });
		for (const provider of working.getProviders()) {
			const capturedModels = [...working.getModels(provider.id)];
			const view: Provider = {
				...provider,
				getModels: () => capturedModels,
				refreshModels: provider.refreshModels
					? async (context) => {
							await this.enqueue(
								context.signal,
								() => undefined,
								async () => {
									await this.runTransaction(
										{
											allowNetwork: context.allowNetwork,
											force: context.force,
											signal: context.signal,
										},
										async (candidate) => {
											await candidate.getProvider(provider.id)?.refreshModels?.(context);
										},
										undefined,
										sources,
										new Set([provider.id]),
									);
								},
							);
						}
					: undefined,
				filterModels: provider.filterModels
					? (models, credential) => provider.filterModels!(models, credential)
					: undefined,
				// Keep explicit method call so class/prototype stream handlers retain their receiver.
				stream: (model, context, options) => provider.stream(model, context, options),
				streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
			};
			stable.setProvider(view);
		}
		return stable;
	}

	/** Memoize credential reads for one transaction/inspection; optionally drop cache after mutate. */
	private memoizedCredentialStore(store: CredentialStore, invalidateOnMutate: boolean): CredentialStore {
		const reads = new Map<string, Promise<Credential | undefined>>();
		return {
			read: (providerId) => {
				const existing = reads.get(providerId);
				if (existing) return existing;
				const pending = store.read(providerId);
				reads.set(providerId, pending);
				return pending;
			},
			list: () => store.list(),
			modify: async (providerId, fn) => {
				const result = await store.modify(providerId, fn);
				if (invalidateOnMutate) reads.delete(providerId);
				return result;
			},
			delete: async (providerId) => {
				await store.delete(providerId);
				if (invalidateOnMutate) reads.delete(providerId);
			},
		};
	}

	private async inspectCandidate(
		models: Models,
		transactionCredentials: CredentialStore = this.credentials,
	): Promise<ModelRuntimeSnapshot> {
		const providers = models.getProviders();
		const inspection = createModels({ credentials: transactionCredentials, modelsStore: this.modelsStore });
		for (const provider of providers) inspection.setProvider(provider);
		const [checks, available, credentials] = await Promise.all([
			Promise.all(
				providers.map(
					async (provider): Promise<readonly [string, AuthCheck | undefined]> => [
						provider.id,
						await inspection.checkAuth(provider.id),
					],
				),
			),
			inspection.getAvailable(),
			this.credentials.list(),
		]);
		const auth = new Map(checks);
		const providersById = new Map(providers.map((provider) => [provider.id, provider]));
		return {
			all: [...models.getModels()],
			available: [...available],
			configuredProviders: new Set(
				checks.filter((entry): entry is readonly [string, AuthCheck] => entry[1] !== undefined).map(([id]) => id),
			),
			storedCredentialTypes: new Map(
				credentials.flatMap((entry) =>
					providersById.has(entry.providerId) ? [[entry.providerId, entry.type] as const] : [],
				),
			),
			runtimeProviders: new Set(
				providers
					.filter(
						(provider) => provider.auth.apiKey !== undefined && this.credentials.hasRuntimeApiKey(provider.id),
					)
					.map((provider) => provider.id),
			),
			auth,
		};
	}

	private enqueue<T>(signal: AbortSignal | undefined, canceled: () => T, operation: () => Promise<T>): Promise<T> {
		if (signal?.aborted) return Promise.resolve(canceled());
		let started = false;
		let resolveCanceled: ((value: T) => void) | undefined;
		const canceledWhileQueued = new Promise<T>((resolve) => {
			resolveCanceled = resolve;
		});
		const onAbort = () => {
			if (!started) resolveCanceled?.(canceled());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const execution = this.transactionTail
			.catch(() => {})
			.then(async () => {
				if (signal?.aborted) return canceled();
				started = true;
				signal?.removeEventListener("abort", onAbort);
				return operation();
			});
		this.transactionTail = execution.then(
			() => {},
			() => {},
		);
		return Promise.race([execution, canceledWhileQueued]).finally(() => {
			signal?.removeEventListener("abort", onAbort);
			resolveCanceled = undefined;
		});
	}

	private async runTransaction<T>(
		options: ModelsRefreshOptions,
		mutate: ((models: MutableModels) => Promise<T>) | undefined,
		defaultValue: T,
		sources = this.captureSources(),
		alreadyRefreshedProviders?: ReadonlySet<string>,
	): Promise<TransactionResult<T>> {
		const config = await ModelConfig.load(this.modelsPath);
		if (options.signal?.aborted) return { refresh: abortedResult(), value: defaultValue };
		const transactionCredentials = this.memoizedCredentialStore(this.credentials, true);
		const composed = this.composeModels(config, sources, transactionCredentials);
		const value = mutate ? await mutate(composed.models) : defaultValue;
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		const refreshModels = alreadyRefreshedProviders
			? createModels({ credentials: this.credentials, modelsStore: this.modelsStore })
			: composed.models;
		if (alreadyRefreshedProviders) {
			for (const provider of composed.models.getProviders()) {
				refreshModels.setProvider(
					alreadyRefreshedProviders.has(provider.id) ? { ...provider, refreshModels: undefined } : provider,
				);
			}
		}
		const refresh = ((await refreshModels.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		if (refresh.aborted || options.signal?.aborted || sources.revision !== this.sourceRevision) {
			return { refresh: { ...refresh, aborted: true }, value };
		}
		const snapshot = await this.inspectCandidate(composed.models, transactionCredentials);
		if (options.signal?.aborted || sources.revision !== this.sourceRevision) {
			return { refresh: { ...refresh, aborted: true }, value };
		}
		this.published = {
			models: this.materializeModels(composed.models, sources),
			config,
			extensions: sources.extensions,
			compositionErrors: composed.compositionErrors,
			snapshot,
		};
		this.availability.error = undefined;
		this.convergence.error = undefined;
		return { refresh, value };
	}

	private publishSourcesSynchronously(): void {
		const sources = this.captureSources();
		const config = this.config;
		const composed = this.composeModels(config, sources);
		const models = this.materializeModels(composed.models, sources);
		const all = [...models.getModels()];
		const previous = this.snapshot;
		const auth = new Map<string, AuthCheck | undefined>();
		const configuredProviders = new Set<string>();
		const storedCredentialTypes = new Map<string, Credential["type"]>();
		const runtimeProviders = new Set<string>();
		for (const provider of models.getProviders()) {
			const supportsApiKey = provider.auth.apiKey !== undefined;
			const supportsOAuth = provider.auth.oauth !== undefined;
			const storedType = previous.storedCredentialTypes.get(provider.id);
			const compatibleStored = storedType !== undefined && supportsCredentialType(provider, storedType);
			const incompatibleStored = storedType !== undefined && !compatibleStored;
			if (storedType !== undefined) storedCredentialTypes.set(provider.id, storedType);
			const compatibleRuntime = previous.runtimeProviders.has(provider.id) && supportsApiKey;
			if (compatibleRuntime) runtimeProviders.add(provider.id);

			const oldCheck = previous.auth.get(provider.id);
			const compatibleOldCheck =
				!incompatibleStored &&
				(oldCheck?.type === "api_key" ? supportsApiKey : oldCheck?.type === "oauth" ? supportsOAuth : false);
			if (compatibleOldCheck && oldCheck) auth.set(provider.id, oldCheck);

			const configured = configuredRequestAuthStatus(
				config.getProvider(provider.id),
				sources.extensions.get(provider.id),
			);
			const compatibleConfigured = configured?.configured === true && supportsApiKey && !incompatibleStored;
			const projectedType = compatibleStored
				? storedType
				: compatibleRuntime || compatibleConfigured
					? "api_key"
					: compatibleOldCheck
						? oldCheck?.type
						: undefined;
			if (compatibleStored || compatibleRuntime || compatibleConfigured || compatibleOldCheck) {
				configuredProviders.add(provider.id);
				if (!auth.has(provider.id) && projectedType) {
					auth.set(provider.id, { type: projectedType, source: "configured provider" });
				}
			}
		}
		this.published = {
			models,
			config,
			extensions: sources.extensions,
			compositionErrors: composed.compositionErrors,
			snapshot: {
				all,
				available: all.filter((entry) => configuredProviders.has(entry.provider)),
				configuredProviders,
				storedCredentialTypes,
				runtimeProviders,
				auth,
			},
		};
		this.availability.error = undefined;
	}

	private requestConvergence(): void {
		this.convergence.target = this.sourceRevision;
		if (this.convergence.scheduled) return;
		if (this.convergence.target <= this.convergence.suppressedAt) this.convergence.suppressedAt = 0;
		this.convergence.scheduled = true;
		const scheduledFor = this.convergence.target;
		queueMicrotask(() => {
			void this.enqueue(
				undefined,
				() => undefined,
				async () => {
					// Bound self-triggered registration churn; a later external registration re-requests.
					let attempts = 0;
					try {
						while (this.convergence.progress < this.convergence.target && attempts < 8) {
							attempts++;
							const target = this.sourceRevision;
							const result = await this.runTransaction({ allowNetwork: false }, undefined, undefined);
							if (!result.refresh.aborted) this.convergence.progress = target;
						}
						if (this.convergence.progress < this.convergence.target) {
							this.convergence.suppressedAt = this.convergence.target;
							this.convergence.error = "Provider registration convergence did not stabilize after 8 attempts.";
						}
					} catch (error) {
						this.convergence.suppressedAt = scheduledFor;
						this.convergence.error = `Provider registration convergence failed: ${errorMessage(error)}`;
					} finally {
						this.convergence.scheduled = false;
						if (
							this.convergence.target > this.convergence.progress &&
							this.convergence.target > this.convergence.suppressedAt
						) {
							this.requestConvergence();
						}
					}
				},
			);
		});
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId);
	}

	private availabilityFor(state: PublishedState): Promise<readonly Model<Api>[]> {
		const existing = this.availability.reads.get(state);
		if (existing) return existing;
		const pending = state.models.getAvailable();
		this.availability.reads.set(state, pending);
		void pending
			.finally(() => {
				if (this.availability.reads.get(state) === pending) this.availability.reads.delete(state);
			})
			.catch(() => {});
		return pending;
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		if (providerId) {
			const state = this.published;
			try {
				const available = await state.models.getAvailable(providerId);
				if (state === this.published) this.availability.error = undefined;
				return available;
			} catch (error) {
				if (state === this.published) this.availability.error = errorMessage(error);
				throw error;
			}
		}
		for (;;) {
			const state = this.published;
			try {
				const available = await this.availabilityFor(state);
				if (state !== this.published) continue;
				this.availability.error = undefined;
				return available;
			} catch (error) {
				if (state !== this.published) continue;
				this.availability.error = errorMessage(error);
				throw error;
			}
		}
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.published.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availability.error) errors.push(`Availability refresh: ${this.availability.error}`);
		if (this.convergence.error) errors.push(this.convergence.error);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.published.extensions.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		const state = this.published;
		if (typeof providerOrModel === "string") return state.models.getAuth(providerOrModel, overrides);
		const resolution = await state.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			state.config.getProvider(providerOrModel.provider),
			state.extensions.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	async setRuntimeApiKey(
		providerId: string,
		apiKey: string,
		refreshOptions: ModelsRefreshOptions = {},
	): Promise<void> {
		await this.enqueue(
			refreshOptions.signal,
			() => undefined,
			async () => {
				this.credentials.setRuntimeApiKey(providerId, apiKey);
				await this.runTransaction(refreshOptions, undefined, undefined);
			},
		);
	}

	async removeRuntimeApiKey(providerId: string): Promise<void> {
		await this.enqueue(
			undefined,
			() => undefined,
			async () => {
				this.credentials.removeRuntimeApiKey(providerId);
				await this.runTransaction({ allowNetwork: this.modelNetworkEnabled }, undefined, undefined);
			},
		);
	}

	listCredentials(): Promise<readonly CredentialInfo[]> {
		return this.credentials.list();
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.snapshot.runtimeProviders.has(providerId)) return { configured: true, source: "runtime" };
		if (!this.snapshot.configuredProviders.has(providerId)) return { configured: false };
		if (this.snapshot.storedCredentialTypes.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.published.extensions.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	private async prepareRequest(
		model: Model<Api>,
		options: (StreamOptions & ModelsStreamTransforms) | undefined,
	): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions }> {
		const state = this.published;
		const provider = state.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env });
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		const { transformHeaders, ...providerOptions } = options ?? {};
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			},
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsStreamTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
		});
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		return this.enqueue(
			undefined,
			() => {
				throw new ModelsError("auth", `Login canceled for ${providerId}`);
			},
			async () => {
				const result = await this.runTransaction(
					{ allowNetwork: this.modelNetworkEnabled },
					(models) => models.login(providerId, type, interaction),
					undefined as never,
				);
				return result.value;
			},
		);
	}

	async logout(providerId: string): Promise<void> {
		await this.enqueue(
			undefined,
			() => undefined,
			async () => {
				await this.runTransaction(
					{ allowNetwork: this.modelNetworkEnabled },
					async (models) => {
						await models.logout(providerId);
					},
					undefined,
				);
			},
		);
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const sources = this.captureSources();
		return this.enqueue(options.signal, abortedResult, async () => {
			try {
				return (await this.runTransaction(options, undefined, undefined, sources)).refresh;
			} catch (error) {
				this.availability.error = errorMessage(error);
				throw error;
			}
		});
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.sourceRevision++;
		this.publishSourcesSynchronously();
		this.requestConvergence();
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		const builtin = this.configuredBuiltins(this.config).get(providerId);
		validateExtensionProvider(providerId, builtin, this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.sourceRevision++;
		this.publishSourcesSynchronously();
		this.requestConvergence();
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.sourceRevision++;
		this.publishSourcesSynchronously();
		this.requestConvergence();
	}
}
