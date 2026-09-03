import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { RemoteServiceBindingImpl } from "../services/consumer.ts";
import { ServiceSlot } from "../services/handle.ts";
import { InstanceDirectory, type InstanceDirectoryEntry } from "../services/instances.ts";
import { createLoopbackServiceTransport } from "../services/loopback.ts";
import { RemoteServiceProvider, validateRemoteServiceImplementation } from "../services/provider.ts";
import { MutableReplicatedStateImpl } from "../services/state.ts";
import type {
	Context,
	Facet,
	FacetEnvironment,
	FacetOptions,
	RemoteServiceContract,
	RemoteServiceSource,
	RemoteServices,
	Service,
	ServiceMode,
	ServiceSpawner,
} from "../types.ts";

interface FacetServiceReference {
	readonly serviceId: string;
	readonly service: Service<unknown>;
	readonly mode: ServiceMode;
}

interface ExternalService {
	readonly service: Service<unknown>;
	readonly mode: ServiceMode;
	readonly source: RemoteServiceSource;
}

interface FacetShape {
	facetId: string;
	requires: readonly FacetServiceReference[];
	provides: readonly FacetServiceReference[];
}

interface FacetRuntime extends FacetShape {
	requires: FacetServiceReference[];
	provides: FacetServiceReference[];
	readonly lifecycle: FacetLifecycle;
	readonly provisions: FacetProvision[];
	readonly singletonViews: Map<string, unknown>;
}

type LifecycleState = "setting_up" | "prepared" | "active" | "disposing" | "dead";
type GenerationPhase =
	| "setup"
	| "assembling"
	| "connecting"
	| "activating"
	| "active"
	| "reloading"
	| "disposing"
	| "dead";
type Disposal = () => void | Promise<void>;

class FacetLifecycle {
	readonly id: string;
	readonly #effects: Disposal[] = [];
	readonly #observations: Array<() => Disposal> = [];
	readonly #activate: Array<() => void | Promise<void>> = [];
	#state: LifecycleState = "setting_up";
	#serviceAccess = false;

	constructor(id: string) {
		this.id = id;
	}

	assertSettingUp(operation: string): void {
		if (this.#state !== "setting_up") {
			throw new Error(`Facet ${this.id} can ${operation} only during setup`);
		}
	}

	assertRunning(operation: string): void {
		if (this.#state !== "setting_up" && this.#state !== "active") {
			throw new Error(`Facet ${this.id} cannot ${operation} while ${this.#state}`);
		}
	}

	assertActive(operation: string): void {
		if (this.#state !== "active") throw new Error(`Facet ${this.id} can ${operation} only while active`);
	}

	assertServiceAccess(): void {
		if (!this.#serviceAccess) {
			throw new Error(`Facet ${this.id} service handles cannot be used while ${this.#state}`);
		}
	}

	revoke(): void {
		this.#serviceAccess = false;
	}

	own(disposal: Disposal): void {
		this.assertRunning("own resources");
		this.#effects.push(disposal);
	}

	observe(start: () => Disposal): void {
		this.assertSettingUp("observe services");
		this.#observations.push(start);
	}

	onActivate(callback: () => void | Promise<void>): void {
		this.assertSettingUp("register activation callbacks");
		this.#activate.push(callback);
	}

	prepared(): void {
		this.assertSettingUp("finish setup");
		this.#state = "prepared";
	}

	async activate(): Promise<void> {
		if (this.#state !== "prepared") throw new Error(`Facet ${this.id} is not prepared`);
		this.#state = "active";
		this.#serviceAccess = true;
		for (const start of this.#observations) this.#effects.push(start());
		for (const callback of this.#activate) await callback();
	}

	async dispose(): Promise<void> {
		if (this.#state === "dead") return;
		this.#state = "disposing";
		const errors: unknown[] = [];
		for (const effect of this.#effects.splice(0).reverse()) {
			try {
				await effect();
			} catch (error) {
				errors.push(error);
			}
		}
		this.#observations.length = 0;
		this.#activate.length = 0;
		this.#serviceAccess = false;
		this.#state = "dead";
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, `Failed to dispose facet ${this.id}`);
	}
}

interface KeyedServiceSource {
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void;
}

interface LocalKeyedRegistration {
	readonly generations: Map<string, number>;
	readonly directory: InstanceDirectory<InstanceDirectoryEntry>;
}

class LocalKeyedServiceRegistry implements KeyedServiceSource {
	readonly #registrations = new Map<string, LocalKeyedRegistration>();
	#disposed = false;

	constructor(services: readonly { readonly id: string }[], onError: (error: Error) => void) {
		const ids = services.map(({ id }) => id);
		if (new Set(ids).size !== ids.length) throw new TypeError("Local keyed service registry has duplicate IDs");
		for (const serviceId of ids) {
			this.#registrations.set(serviceId, {
				generations: new Map(),
				directory: new InstanceDirectory({ ready: true, onError }),
			});
		}
	}

	spawn<T>(service: Service<T>, key: string, implementation: T): () => void {
		this.#assertActive();
		if (key.length === 0) throw new TypeError("Local service instance key must not be empty");
		if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
			throw new TypeError(`Local service ${service.id} implementation must be an object`);
		}
		const registration = this.#registration(service.id);
		if (registration.directory.get(key) !== undefined) {
			throw new Error(`Local service ${service.id} already has a live instance with key ${key}`);
		}
		const generation = (registration.generations.get(key) ?? 0) + 1;
		registration.generations.set(key, generation);
		const instance: InstanceDirectoryEntry = {
			key,
			generation,
			service: implementation as object,
			deactivate() {},
		};
		registration.directory.insert(instance);
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			registration.directory.remove(instance);
		};
	}

	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void {
		this.#assertActive();
		return this.#registration(service.id).directory.observe(handler);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const registration of this.#registrations.values()) registration.directory.dispose();
		this.#registrations.clear();
	}

	#registration(serviceId: string): LocalKeyedRegistration {
		const registration = this.#registrations.get(serviceId);
		if (registration === undefined) throw new Error(`Local keyed service ${serviceId} is not registered`);
		return registration;
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Local keyed service registry is disposed");
	}
}

class HostServiceSlots {
	readonly #singletons = new Map<string, ServiceSlot>();
	readonly #keyedSources = new Map<string, KeyedServiceSource>();

	getSingleton<T>(service: Service<T>, assertAccess: () => void): T {
		let slot = this.#singletons.get(service.id);
		if (slot === undefined) {
			slot = new ServiceSlot(service.id, !service.local);
			this.#singletons.set(service.id, slot);
		}
		return slot.view<T>(assertAccess);
	}

	hasSingleton(serviceId: string): boolean {
		return this.#singletons.has(serviceId);
	}

	observe<T>(
		service: Service<T>,
		assertAccess: () => void,
		handler: (service: T, context: Context) => void | Promise<void>,
	): Disposal {
		const source = this.#keyedSources.get(service.id);
		if (source === undefined) throw new Error(`Service ${service.id} is disconnected`);
		let stopped = false;
		const stop = source.observe(service, (target, context) => {
			const slot = new ServiceSlot(service.id, !service.local);
			slot.bind(target as object);
			return handler(
				slot.view<T>(() => {
					assertAccess();
					if (stopped || context.abortSignal?.aborted) {
						throw new Error(`Keyed service ${service.id} observation is closed`);
					}
				}),
				context,
			);
		});
		return () => {
			if (stopped) return;
			stopped = true;
			stop();
		};
	}

	bindSingleton(serviceId: string, target: object): void {
		this.#singletons.get(serviceId)?.bind(target);
	}

	bindKeyed(serviceId: string, services: KeyedServiceSource): void {
		this.#keyedSources.set(serviceId, services);
	}

	dispose(): void {
		for (const slot of this.#singletons.values()) slot.unbind();
		this.#singletons.clear();
		this.#keyedSources.clear();
	}
}

type ServiceInstanceInstaller<T> = (key: string, implementation: T) => () => void;

interface StagedServiceInstance<T> {
	readonly key: string;
	readonly implementation: T;
	release?: () => void;
}

class StagedServiceSpawner<T> implements ServiceSpawner<T> {
	readonly #lifecycle: FacetLifecycle;
	readonly #validate: (key: string, implementation: T) => void;
	readonly #instances = new Map<string, StagedServiceInstance<T>>();
	#installer: ServiceInstanceInstaller<T> | undefined;

	constructor(lifecycle: FacetLifecycle, validate: (key: string, implementation: T) => void) {
		this.#lifecycle = lifecycle;
		this.#validate = validate;
	}

	connect(installer: ServiceInstanceInstaller<T>): void {
		if (this.#installer !== undefined) throw new Error("Facet service provider is already connected");
		this.#installer = installer;
		for (const instance of this.#instances.values()) {
			instance.release = installer(instance.key, instance.implementation);
		}
	}

	spawn(key: string, implementation: T): () => void {
		this.#lifecycle.assertActive("spawn service instances");
		this.#validate(key, implementation);
		if (this.#instances.has(key)) throw new Error(`Facet service already has a live instance with key ${key}`);
		const instance: StagedServiceInstance<T> = { key, implementation };
		this.#instances.set(key, instance);
		if (this.#installer !== undefined) instance.release = this.#installer(key, implementation);
		const close = (): void => {
			if (this.#instances.get(key) !== instance) return;
			this.#instances.delete(key);
			instance.release?.();
		};
		this.#lifecycle.own(close);
		return close;
	}
}

type FacetProvision =
	| {
			readonly kind: "singleton";
			readonly service: { readonly id: string; readonly local: boolean };
			readonly implementation: object;
			install(provider: RemoteServiceProvider): void;
			validateReplacement(provider: RemoteServiceProvider): void;
			replace(provider: RemoteServiceProvider): void;
	  }
	| {
			readonly kind: "keyed";
			readonly service: { readonly id: string; readonly local: boolean };
			connectLocal(registry: LocalKeyedServiceRegistry): void;
			connectRemote(provider: RemoteServiceProvider): void;
	  };

/** Private lifecycle and dependency kernel behind the atomic host entry point. */
export class FacetKernel {
	readonly #initialFacets: readonly Facet[];
	readonly #serviceSources: readonly RemoteServiceSource[];
	readonly #onError: (error: Error) => void;
	readonly #facets = new Map<string, FacetRuntime>();
	readonly #serviceSlots: HostServiceSlots;
	readonly #sourceBindings = new Map<RemoteServiceSource, RemoteServices>();
	#activationOrder: readonly string[] = [];
	#provider: RemoteServiceProvider | undefined;
	#internalServices: RemoteServices | undefined;
	#localKeyedServices: LocalKeyedServiceRegistry | undefined;
	#phase: GenerationPhase = "setup";

	constructor(options: FacetOptions) {
		const ids = options.facets.map((facet) => facet.id);
		if (ids.some((id) => id.length === 0)) throw new Error("Facet ID must not be empty");
		if (new Set(ids).size !== ids.length) throw new Error("Facet IDs must be unique within a generation");
		this.#initialFacets = options.facets;
		this.#serviceSources = options.serviceSources ?? [];
		this.#onError = options.onError ?? (() => {});
		this.#serviceSlots = new HostServiceSlots();
	}

	get provider(): RemoteServiceProvider {
		if (this.#provider === undefined) throw new Error("Facet service provider is not assembled");
		return this.#provider;
	}

	#createFacetRuntime(facetId: string): FacetRuntime {
		return {
			facetId,
			requires: [],
			provides: [],
			lifecycle: new FacetLifecycle(facetId),
			provisions: [],
			singletonViews: new Map(),
		};
	}

	#setupFacet(facet: Facet, record: FacetRuntime): void {
		const result: unknown = facet.setup(this.#environment(record));
		if (isPromiseLike(result)) {
			void Promise.resolve(result).catch(() => {});
			throw new Error(`Facet ${facet.id} setup must be synchronous`);
		}
		record.lifecycle.prepared();
	}

	async activate(): Promise<void> {
		const records: FacetRuntime[] = [];
		try {
			for (const facet of this.#initialFacets) {
				const record = this.#createFacetRuntime(facet.id);
				this.#facets.set(facet.id, record);
				this.#setupFacet(facet, record);
				records.push(record);
			}

			this.#phase = "assembling";
			const externalServices = await this.#resolveExternalServices(records);
			this.#activationOrder = validateFacets(records, externalServices);
			this.#assembleProviders();
			this.#bindServices(externalServices);

			this.#phase = "connecting";
			await Promise.all(
				[...this.#sourceBindings.values(), this.#internalServiceBinding].map((services) =>
					services.ready(BACKGROUND_CONTEXT),
				),
			);

			this.#phase = "activating";
			for (const id of this.#activationOrder) await this.#facets.get(id)!.lifecycle.activate();
			this.#phase = "active";
		} catch (error) {
			const cleanupErrors = await this.#terminate();
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "Facet generation startup and cleanup failed");
			}
			throw error;
		}
	}

	async reload(facets: readonly Facet[]): Promise<void> {
		if (this.#phase !== "active") throw new Error(`Facet host cannot reload while ${this.#phase}`);
		const ids = facets.map(({ id }) => id);
		if (ids.some((id) => id.length === 0)) throw new Error("Facet ID must not be empty");
		if (new Set(ids).size !== ids.length) throw new Error("Reloaded facet IDs must be unique");
		for (const id of ids) {
			if (!this.#facets.has(id)) throw new Error(`Facet ${id} is not active`);
		}
		this.#phase = "reloading";

		const staged: FacetRuntime[] = [];
		const candidates: FacetRuntime[] = [];
		try {
			for (const facet of facets) {
				const record = this.#createFacetRuntime(facet.id);
				staged.push(record);
				this.#setupFacet(facet, record);
				const previous = this.#facets.get(facet.id)!;
				if (!sameFacetShape(previous, record)) {
					throw new Error(`Reloaded facet ${facet.id} must preserve its service requirements and provisions`);
				}
				this.#validateReplacementProvisions(record.provisions);
				candidates.push(record);
			}
		} catch (error) {
			const cleanupErrors = await disposeFacetRecords(staged.reverse());
			if (cleanupErrors.length > 0) {
				const abortErrors = await this.#abort();
				throw new AggregateError(
					[error, ...cleanupErrors, ...abortErrors],
					"Facet reload setup and cleanup failed",
				);
			}
			this.#phase = "active";
			throw error;
		}

		const replacements = new Map(candidates.map((record) => [record.facetId, record]));
		const candidateOrder = this.#activationOrder.flatMap((id) => {
			const candidate = replacements.get(id);
			return candidate === undefined ? [] : [candidate];
		});
		try {
			for (const candidate of candidateOrder) await candidate.lifecycle.activate();
			for (const candidate of candidateOrder) this.#validateReplacementProvisions(candidate.provisions);
		} catch (error) {
			const cleanupErrors = await disposeFacetRecords([...candidateOrder].reverse());
			if (cleanupErrors.length > 0) {
				const abortErrors = await this.#abort();
				throw new AggregateError(
					[error, ...cleanupErrors, ...abortErrors],
					"Facet reload activation and cleanup failed",
				);
			}
			this.#phase = "active";
			throw error;
		}

		const previous = candidateOrder.map(({ facetId }) => this.#facets.get(facetId)!);
		for (const candidate of candidateOrder) this.#facets.set(candidate.facetId, candidate);
		try {
			for (const candidate of candidateOrder) {
				for (const provision of candidate.provisions) {
					if (provision.kind !== "singleton") continue;
					if (provision.service.local) {
						this.#serviceSlots.bindSingleton(provision.service.id, provision.implementation);
					} else {
						provision.replace(this.provider);
					}
				}
			}
			const retirementErrors = await disposeFacetRecords(previous.reverse());
			if (retirementErrors.length === 1) throw retirementErrors[0];
			if (retirementErrors.length > 1) {
				throw new AggregateError(retirementErrors, "Failed to retire replaced facets");
			}
			for (const candidate of candidateOrder) {
				for (const provision of candidate.provisions) {
					if (provision.kind !== "keyed") continue;
					if (provision.service.local) provision.connectLocal(this.#localKeyedRegistry);
					else provision.connectRemote(this.provider);
				}
			}
		} catch (error) {
			const abortErrors = await this.#abort(previous);
			throw new AggregateError([error, ...abortErrors], "Facet reload failed after cutover");
		}
		this.#phase = "active";
	}

	async dispose(): Promise<void> {
		if (this.#phase === "dead") return;
		if (this.#phase !== "active") throw new Error(`Facet host cannot be disposed while ${this.#phase}`);
		const errors = await this.#terminate();
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose facet generation");
	}

	#validateReplacementProvisions(provisions: readonly FacetProvision[]): void {
		for (const provision of provisions) {
			if (provision.kind !== "singleton" || provision.service.local) continue;
			provision.validateReplacement(this.provider);
		}
	}

	#environment(runtime: FacetRuntime): FacetEnvironment {
		const { lifecycle, provisions } = runtime;
		return {
			provide: <T>(service: Service<T>, implementation: NoInfer<T>): void => {
				lifecycle.assertSettingUp("provide services");
				if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
					throw new TypeError(`Service ${service.id} implementation must be an object`);
				}
				recordServiceReference(runtime.provides, service, "singleton");
				provisions.push({
					kind: "singleton",
					service,
					implementation,
					install: (provider) => provider.provide(service, implementation as NoInfer<RemoteServiceContract<T>>),
					validateReplacement: (provider) =>
						provider.validateReplacement(service, implementation as NoInfer<RemoteServiceContract<T>>),
					replace: (provider) => provider.replace(service, implementation as NoInfer<RemoteServiceContract<T>>),
				});
			},
			provideMany: <T>(service: Service<T>): ServiceSpawner<T> => {
				lifecycle.assertSettingUp("provide service instances");
				recordServiceReference(runtime.provides, service, "keyed");
				const instances = new StagedServiceSpawner<T>(lifecycle, (key, implementation) => {
					if (key.length === 0) throw new TypeError("Facet service instance key must not be empty");
					if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
						throw new TypeError(`Facet service ${service.id} implementation must be an object`);
					}
					if (!service.local) validateRemoteServiceImplementation(service.id, implementation);
				});
				provisions.push({
					kind: "keyed",
					service,
					connectLocal: (registry) =>
						instances.connect((key, implementation) => registry.spawn(service, key, implementation)),
					connectRemote: (provider) =>
						instances.connect((key, implementation) =>
							provider.spawn(service, key, implementation as NoInfer<RemoteServiceContract<T>>),
						),
				});
				return instances;
			},
			use: <T>(service: Service<T>): T => {
				lifecycle.assertSettingUp("acquire services");
				recordServiceReference(runtime.requires, service, "singleton");
				let view = runtime.singletonViews.get(service.id);
				if (view === undefined) {
					view = this.#serviceSlots.getSingleton<T>(service, () => lifecycle.assertServiceAccess());
					runtime.singletonViews.set(service.id, view);
				}
				return view as T;
			},
			observe: <T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): void => {
				lifecycle.assertSettingUp("observe services");
				recordServiceReference(runtime.requires, service, "keyed");
				lifecycle.observe(() =>
					this.#serviceSlots.observe(service, () => lifecycle.assertServiceAccess(), handler),
				);
			},
			replicatedState: <T extends object>(initial: T) => {
				lifecycle.assertRunning("create replicated state");
				return new MutableReplicatedStateImpl(initial);
			},
			own: (disposal) => lifecycle.own(disposal),
			onActivate: (callback) => lifecycle.onActivate(callback),
			onDeactivate: (callback) => lifecycle.own(callback),
		};
	}

	async #resolveExternalServices(records: readonly FacetShape[]): Promise<ReadonlyMap<string, ExternalService>> {
		const catalogues = await Promise.all(
			this.#serviceSources.map(async (source) => ({
				source,
				entries: await source.catalogue(BACKGROUND_CONTEXT),
			})),
		);
		const offered = new Map<string, { readonly mode: ServiceMode; readonly source: RemoteServiceSource }>();
		for (const { source, entries } of catalogues) {
			for (const { serviceId, mode } of entries) {
				if (offered.has(serviceId)) {
					throw new Error(`Facet host service ${serviceId} is offered by more than one source`);
				}
				offered.set(serviceId, { mode, source });
			}
		}

		const local = new Set(records.flatMap(({ provides }) => provides.map(({ serviceId }) => serviceId)));
		const external = new Map<string, ExternalService>();
		for (const { requires } of records) {
			for (const requirement of requires) {
				if (local.has(requirement.serviceId) || external.has(requirement.serviceId)) continue;
				let source = offered.get(requirement.serviceId);
				if (source === undefined) {
					const deferred = this.#serviceSources.filter(
						({ acceptsUnavailableServices }) => acceptsUnavailableServices,
					);
					if (deferred.length > 1) {
						throw new Error(`Facet host service ${requirement.serviceId} has more than one deferred source`);
					}
					if (deferred.length === 1) source = { mode: requirement.mode, source: deferred[0]! };
				}
				if (source !== undefined) {
					external.set(requirement.serviceId, { ...source, service: requirement.service });
				}
			}
		}
		const serviceIdsBySource = new Map<RemoteServiceSource, string[]>();
		for (const [serviceId, { source }] of external) {
			let serviceIds = serviceIdsBySource.get(source);
			if (serviceIds === undefined) {
				serviceIds = [];
				serviceIdsBySource.set(source, serviceIds);
			}
			serviceIds.push(serviceId);
		}
		for (const [source, serviceIds] of serviceIdsBySource) {
			this.#sourceBindings.set(
				source,
				source.open({
					services: serviceIds.map((id) => ({ id })),
					assertAccess: () => this.#assertServiceTargetAccess(),
					onError: this.#onError,
				}),
			);
		}
		return external;
	}

	#assembleProviders(): void {
		const provisions = this.#provisions();
		const remoteProvisions = provisions.filter(({ service }) => !service.local);
		const provider = new RemoteServiceProvider(
			remoteProvisions.map(({ service, kind }) => ({ service, mode: kind })),
		);
		const internalServices = new RemoteServiceBindingImpl({
			services: remoteProvisions.map(({ service }) => service),
			transport: createLoopbackServiceTransport(provider),
			assertAccess: () => this.#assertServiceTargetAccess(),
			onError: this.#onError,
		});
		const localKeyedServices = new LocalKeyedServiceRegistry(
			provisions.flatMap((provision) =>
				provision.kind === "keyed" && provision.service.local ? [provision.service] : [],
			),
			this.#onError,
		);
		this.#provider = provider;
		this.#internalServices = internalServices;
		this.#localKeyedServices = localKeyedServices;
		for (const provision of provisions) {
			if (provision.kind === "singleton") {
				if (!provision.service.local) provision.install(provider);
			} else if (provision.service.local) {
				provision.connectLocal(localKeyedServices);
			} else {
				provision.connectRemote(provider);
			}
		}
	}

	#bindServices(externalServices: ReadonlyMap<string, ExternalService>): void {
		for (const provision of this.#provisions()) {
			if (provision.kind === "singleton") {
				if (!this.#serviceSlots.hasSingleton(provision.service.id)) continue;
				const target = provision.service.local
					? provision.implementation
					: (this.#internalServiceBinding.use(provision.service) as object);
				this.#serviceSlots.bindSingleton(provision.service.id, target);
			} else {
				this.#serviceSlots.bindKeyed(
					provision.service.id,
					provision.service.local ? this.#localKeyedRegistry : this.#internalServiceBinding,
				);
			}
		}
		for (const [serviceId, { service, mode, source }] of externalServices) {
			const services = this.#sourceBindings.get(source);
			if (services === undefined) throw new Error(`Service source for ${serviceId} is not open`);
			if (mode === "singleton") {
				this.#serviceSlots.bindSingleton(serviceId, services.use(service) as object);
			} else {
				this.#serviceSlots.bindKeyed(serviceId, services);
			}
		}
	}

	#provisions(): FacetProvision[] {
		return [...this.#facets.values()].flatMap(({ provisions }) => provisions);
	}

	get #localKeyedRegistry(): LocalKeyedServiceRegistry {
		if (this.#localKeyedServices === undefined) throw new Error("Facet keyed services are not assembled");
		return this.#localKeyedServices;
	}

	get #internalServiceBinding(): RemoteServices {
		if (this.#internalServices === undefined) throw new Error("Facet remote services are not assembled");
		return this.#internalServices;
	}

	async #disposeServiceBindings(): Promise<unknown[]> {
		const bindings = [...this.#sourceBindings.values()];
		this.#sourceBindings.clear();
		if (this.#internalServices !== undefined) bindings.push(this.#internalServices);
		this.#internalServices = undefined;
		const results = await Promise.allSettled(bindings.map((services) => services.dispose(BACKGROUND_CONTEXT)));
		return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	}

	#assertServiceTargetAccess(): void {
		if (
			this.#phase !== "activating" &&
			this.#phase !== "active" &&
			this.#phase !== "reloading" &&
			this.#phase !== "disposing"
		) {
			throw new Error(`Facet service targets cannot be used during ${this.#phase}`);
		}
	}

	async #abort(extraRecords: readonly FacetRuntime[] = []): Promise<unknown[]> {
		for (const record of this.#facets.values()) record.lifecycle.revoke();
		for (const record of extraRecords) record.lifecycle.revoke();
		return this.#terminate(extraRecords);
	}

	async #terminate(extraRecords: readonly FacetRuntime[] = []): Promise<unknown[]> {
		this.#phase = "disposing";
		const errors = await this.#disposeLifecycles();
		errors.push(...(await disposeFacetRecords([...extraRecords].reverse())));
		try {
			this.#localKeyedServices?.dispose();
		} catch (error) {
			errors.push(error);
		}
		this.#localKeyedServices = undefined;
		errors.push(...(await this.#disposeServiceBindings()));
		try {
			this.#serviceSlots.dispose();
		} catch (error) {
			errors.push(error);
		}
		try {
			this.#provider?.dispose();
		} catch (error) {
			errors.push(error);
		}
		this.#phase = "dead";
		return errors;
	}

	async #disposeLifecycles(): Promise<unknown[]> {
		const errors: unknown[] = [];
		const order =
			this.#activationOrder.length > 0 ? [...this.#activationOrder].reverse() : [...this.#facets.keys()].reverse();
		for (const id of order) {
			const record = this.#facets.get(id);
			if (record === undefined) continue;
			this.#facets.delete(id);
			try {
				await record.lifecycle.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}
}

async function disposeFacetRecords(records: readonly FacetRuntime[]): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (const record of records) {
		try {
			await record.lifecycle.dispose();
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

function validateFacets(
	records: readonly FacetShape[],
	externalServices: ReadonlyMap<string, { readonly mode: ServiceMode }>,
): string[] {
	const providers = new Map<
		string,
		{ readonly facetId: string | undefined; readonly mode: ServiceMode | undefined }
	>();
	for (const [serviceId, { mode }] of externalServices) providers.set(serviceId, { facetId: undefined, mode });
	for (const record of records) {
		for (const provision of record.provides) {
			const existing = providers.get(provision.serviceId);
			if (existing !== undefined) {
				if (existing.mode !== undefined && existing.mode !== provision.mode) {
					throw new Error(`Service ${provision.serviceId} is provided as both singleton and keyed`);
				}
				if (existing.facetId === undefined) {
					throw new Error(`Service ${provision.serviceId} is provided by both the host and ${record.facetId}`);
				}
				throw new Error(
					`Service ${provision.serviceId} is provided by both ${existing.facetId} and ${record.facetId}`,
				);
			}
			providers.set(provision.serviceId, { facetId: record.facetId, mode: provision.mode });
		}
	}

	const dependencies = new Map(records.map((record) => [record.facetId, new Set<string>()]));
	const dependents = new Map(records.map((record) => [record.facetId, new Set<string>()]));
	for (const record of records) {
		for (const requirement of record.requires) {
			const provider = providers.get(requirement.serviceId);
			if (provider === undefined) {
				throw new Error(
					`Facet ${record.facetId} requires local/${requirement.serviceId}/${requirement.mode}, but no facet provides it`,
				);
			}
			if (provider.mode !== undefined && provider.mode !== requirement.mode) {
				throw new Error(
					`Facet ${record.facetId} requires ${requirement.serviceId} as ${requirement.mode}, but ${provider.facetId ?? "the host"} provides it as ${provider.mode}`,
				);
			}
			if (provider.facetId === undefined || provider.facetId === record.facetId) continue;
			dependencies.get(record.facetId)!.add(provider.facetId);
			dependents.get(provider.facetId)!.add(record.facetId);
		}
	}
	return topologicalOrder(records, dependencies, dependents);
}

function topologicalOrder(
	records: readonly FacetShape[],
	dependencies: ReadonlyMap<string, ReadonlySet<string>>,
	dependents: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
	const remaining = new Map([...dependencies].map(([id, values]) => [id, values.size]));
	const ready = records.map((record) => record.facetId).filter((id) => remaining.get(id) === 0);
	const order: string[] = [];
	while (ready.length > 0) {
		const id = ready.shift()!;
		order.push(id);
		for (const dependent of dependents.get(id) ?? []) {
			const count = remaining.get(dependent)! - 1;
			remaining.set(dependent, count);
			if (count === 0) ready.push(dependent);
		}
	}
	if (order.length !== records.length) {
		const cycle = records.map((record) => record.facetId).filter((id) => remaining.get(id)! > 0);
		throw new Error(`Facet dependency cycle: ${cycle.join(", ")}`);
	}
	return order;
}

function recordServiceReference(
	target: FacetServiceReference[],
	service: { readonly id: string },
	mode: ServiceMode,
): void {
	if (target.some((reference) => reference.serviceId === service.id && reference.mode === mode)) return;
	target.push({ serviceId: service.id, service: service as Service<unknown>, mode });
}

function sameFacetShape(left: FacetShape, right: FacetShape): boolean {
	return sameReferences(left.requires, right.requires) && sameReferences(left.provides, right.provides);
}

function sameReferences(left: readonly FacetServiceReference[], right: readonly FacetServiceReference[]): boolean {
	return (
		left.length === right.length &&
		left.every((reference) =>
			right.some((other) => other.serviceId === reference.serviceId && other.mode === reference.mode),
		)
	);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
