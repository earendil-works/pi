import { awaitWithContext, BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Op } from "../delta/index.ts";
import type {
	Context,
	JsonValue,
	RemoteServiceBinding,
	RemoteServiceBindingOptions,
	RemoteServiceTransport,
	Service,
	ServiceInstanceAddress,
	ServiceInstanceSnapshot,
	ServiceMemberSnapshot,
	ServiceProviderUpdate,
	ServiceSubscription,
} from "../types.ts";
import { RemoteServiceError } from "./errors.ts";
import { ServiceSlot } from "./handle.ts";
import { InstanceDirectory, type InstanceDirectoryEntry } from "./instances.ts";
import { ReplicatedStateReplica, serviceDeliveryContext } from "./state.ts";

type ErrorReporter = (error: Error) => void;
type ServiceMemberKind = ServiceMemberSnapshot["kind"];

class MemberSlot {
	readonly #serviceId: string;
	readonly #member: string;
	readonly #invoke: (args: readonly JsonValue[], context: Context) => Promise<JsonValue | undefined>;
	readonly #state: ReplicatedStateReplica;
	readonly #isActive: () => boolean;
	readonly #assertAccess: () => void;
	readonly value: unknown;
	#kind: ServiceMemberKind | undefined;
	#expectedKind: ServiceMemberKind | undefined;

	constructor(
		serviceId: string,
		member: string,
		invoke: (args: readonly JsonValue[], context: Context) => Promise<JsonValue | undefined>,
		isActive: () => boolean,
		assertAccess: () => void,
		reportError: ErrorReporter,
	) {
		this.#serviceId = serviceId;
		this.#member = member;
		this.#invoke = invoke;
		this.#isActive = isActive;
		this.#assertAccess = assertAccess;
		this.#state = new ReplicatedStateReplica(reportError);
		const callable = (): void => {};
		this.value = new Proxy(callable, {
			apply: (_target, _thisArg, args) => this.#call(args),
			get: (_target, property) => {
				if (property === "value") {
					this.#assertAccess();
					this.#expect("state");
					return this.#state.value;
				}
				if (property === "subscribe") return this.#subscribe.bind(this);
				if (property === Symbol.toStringTag) return "RemoteServiceMember";
				if (property === "then") return undefined;
				return undefined;
			},
		});
	}

	setDescription(kind: ServiceMemberKind): void {
		if (this.#kind !== undefined && this.#kind !== kind) {
			throw new Error(`Remote service member ${this.#serviceId}.${this.#member} changed kind`);
		}
		this.#kind = kind;
		if (this.#expectedKind !== undefined && this.#expectedKind !== kind) {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${this.#serviceId}.${this.#member} is ${kind}, not ${this.#expectedKind}`,
			);
		}
	}

	hydrate(sequence: number, ops: readonly Op[], context: Context): void {
		this.setDescription("state");
		this.#state.hydrate(sequence, ops, context);
	}

	update(sequence: number, ops: readonly Op[], context: Context): void {
		this.setDescription("state");
		this.#state.update(sequence, ops, context);
	}

	clear(): void {
		this.#state.clear();
	}

	#subscribe(listener: (value: JsonValue, context: Context) => void): () => void {
		this.#assertAccess();
		if (typeof listener !== "function") {
			throw new TypeError("Replicated state subscription listener must be a function");
		}
		this.#expect("state");
		return this.#state.subscribe(listener);
	}

	#expect(kind: ServiceMemberKind): void {
		if (this.#expectedKind !== undefined && this.#expectedKind !== kind) {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${this.#serviceId}.${this.#member} was used as two different kinds`,
			);
		}
		this.#expectedKind = kind;
		if (this.#kind !== undefined && this.#kind !== kind) {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${this.#serviceId}.${this.#member} is ${this.#kind}, not ${kind}`,
			);
		}
	}

	#call(args: unknown[]): Promise<JsonValue | undefined> {
		this.#assertAccess();
		this.#expect("method");
		if (!this.#isActive()) {
			return Promise.reject(
				new RemoteServiceError("service_stale_instance", `Remote service ${this.#serviceId} binding is closed`),
			);
		}
		const context = args.at(-1);
		if (!isContext(context)) {
			return Promise.reject(
				new RemoteServiceError(
					"service_invalid_value",
					`Remote service method ${this.#serviceId}.${this.#member} requires a trailing Context`,
				),
			);
		}
		const businessArgs = args.slice(0, -1) as JsonValue[];
		return this.#invoke(businessArgs, context);
	}
}

class ServiceFacade {
	readonly #serviceId: string;
	readonly #address: ServiceInstanceAddress | undefined;
	readonly #transport: RemoteServiceTransport;
	readonly #reportError: ErrorReporter;
	readonly #slots = new Map<string, MemberSlot>();
	readonly #descriptions = new Map<string, ServiceMemberKind>();
	readonly #isActive: () => boolean;
	readonly #assertAccess: () => void;
	readonly proxy: object;

	constructor(
		serviceId: string,
		address: ServiceInstanceAddress | undefined,
		transport: RemoteServiceTransport,
		isActive: () => boolean,
		assertAccess: () => void,
		reportError: ErrorReporter,
	) {
		this.#serviceId = serviceId;
		this.#address = address;
		this.#transport = transport;
		this.#isActive = isActive;
		this.#assertAccess = assertAccess;
		this.#reportError = reportError;
		this.proxy = new Proxy(Object.create(null) as object, {
			get: (_target, property) => {
				if (typeof property !== "string") return undefined;
				return this.#slot(property).value;
			},
		});
	}

	install(snapshot: ServiceInstanceSnapshot, context: Context): void {
		if (!sameAddress(snapshot.instance, this.#address))
			throw new Error("Remote service snapshot has the wrong address");
		const members = validateMembers(snapshot.members);
		for (const name of this.#slots.keys()) {
			if (!members.has(name)) {
				throw new RemoteServiceError(
					"service_member_not_found",
					`Unknown remote service member ${this.#serviceId}.${name}`,
				);
			}
		}
		this.#descriptions.clear();
		for (const [name, member] of members) this.#descriptions.set(name, member.kind);
		for (const member of members.values()) {
			const slot = this.#slots.get(member.name);
			if (member.kind === "state") {
				(slot ?? this.#slot(member.name)).hydrate(member.sequence, member.ops, context);
			} else {
				slot?.setDescription(member.kind);
			}
		}
	}

	update(member: string, sequence: number, ops: readonly Op[], context: Context): void {
		if (this.#descriptions.get(member) !== "state") {
			throw new Error(`Remote service update targets non-state member ${this.#serviceId}.${member}`);
		}
		this.#slot(member).update(sequence, ops, context);
	}

	clear(): void {
		for (const slot of this.#slots.values()) slot.clear();
	}

	#slot(member: string): MemberSlot {
		let slot = this.#slots.get(member);
		if (slot !== undefined) return slot;
		slot = new MemberSlot(
			this.#serviceId,
			member,
			(args, context) =>
				this.#transport.invoke(
					{
						serviceId: this.#serviceId,
						...(this.#address === undefined ? {} : { instance: this.#address }),
						member,
						args,
					},
					context,
				),
			this.#isActive,
			this.#assertAccess,
			this.#reportError,
		);
		const kind = this.#descriptions.get(member);
		if (kind !== undefined) slot.setDescription(kind);
		this.#slots.set(member, slot);
		return slot;
	}
}

interface SingletonBinding {
	facade: ServiceFacade;
	subscription?: ServiceSubscription;
	starting?: Promise<void>;
	active: boolean;
	revision: number;
}

interface KeyedInstance extends InstanceDirectoryEntry {
	readonly facade: ServiceFacade;
}

class KeyedBinding<T> {
	readonly #service: Service<T>;
	readonly #transport: RemoteServiceTransport;
	readonly #reportError: ErrorReporter;
	readonly #assertAccess: () => void;
	readonly #onEmpty: () => void;
	readonly #instances: InstanceDirectory<KeyedInstance>;
	#subscription: ServiceSubscription | undefined;
	#starting: Promise<void> | undefined;
	#closed = false;
	#bound: boolean;
	#revision = 0;

	constructor(
		service: Service<T>,
		transport: RemoteServiceTransport,
		reportError: ErrorReporter,
		assertAccess: () => void,
		onEmpty: () => void,
		bound: boolean,
	) {
		this.#service = service;
		this.#transport = transport;
		this.#reportError = reportError;
		this.#assertAccess = assertAccess;
		this.#onEmpty = onEmpty;
		this.#bound = bound;
		this.#instances = new InstanceDirectory({ ready: false, onError: reportError });
	}

	observe(handler: (service: T, context: Context) => void | Promise<void>): () => void {
		if (this.#closed) throw new Error("Remote keyed service binding is closed");
		let stopped = false;
		const stop = this.#instances.observe<T>((service, context) => {
			const slot = new ServiceSlot(this.#service.id, true);
			void slot.bind(service as object);
			return handler(
				slot.view<T>(() => {
					this.#assertAccess();
					if (stopped || context.abortSignal?.aborted) {
						throw new RemoteServiceError(
							"service_stale_instance",
							`Remote service ${this.#service.id} observation is closed`,
						);
					}
				}),
				context,
			);
		});
		if (this.#bound && this.#starting === undefined) {
			const revision = this.#revision;
			const starting = this.#start(revision);
			this.#starting = starting;
			void starting.catch((error: unknown) => {
				if (!this.#closed && this.#revision === revision && this.#bound) this.#reportError(toError(error));
			});
		}
		return () => {
			if (stopped) return;
			stopped = true;
			stop();
			if (this.#instances.observerCount === 0) this.#onEmpty();
		};
	}

	async rebind(bound: boolean, context: Context): Promise<void> {
		if (this.#closed) return;
		this.#bound = bound;
		const revision = ++this.#revision;
		await this.#reset(context, false);
		if (this.#closed || this.#revision !== revision || this.#bound !== bound) return;
		if (bound && this.#instances.observerCount > 0) {
			const starting = this.#start(revision);
			this.#starting = starting;
			await starting;
		}
	}

	ready(): Promise<void> {
		return this.#starting ?? Promise.resolve();
	}

	async close(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#revision += 1;
		await this.#reset(context, true);
		this.#instances.dispose();
	}

	async #reset(context: Context, waitForStarting: boolean): Promise<void> {
		this.#instances.reset();
		const starting = this.#starting;
		this.#starting = undefined;
		const subscription = this.#subscription;
		this.#subscription = undefined;
		await Promise.all([
			waitForStarting ? starting?.catch(() => {}) : undefined,
			subscription === undefined ? undefined : subscription.close(context),
		]);
	}

	async #start(revision: number): Promise<void> {
		const subscription = await this.#transport.subscribe(
			this.#service.id,
			"keyed",
			(update, context) => {
				if (this.#revision === revision) this.#update(update, context);
			},
			BACKGROUND_CONTEXT,
		);
		if (this.#closed || !this.#bound || this.#revision !== revision) {
			await subscription.close(BACKGROUND_CONTEXT);
			return;
		}
		this.#subscription = subscription;
		if (subscription.snapshot.mode !== "keyed" || subscription.snapshot.serviceId !== this.#service.id) {
			throw new Error(`Remote service ${this.#service.id} returned the wrong keyed snapshot`);
		}
		for (const snapshot of subscription.snapshot.instances) this.#spawn(snapshot, serviceDeliveryContext());
		subscription.activate();
		this.#instances.ready();
	}

	#update(update: ServiceProviderUpdate, context: Context): void {
		if (this.#closed) return;
		try {
			switch (update.type) {
				case "unavailable":
				case "replaced":
					throw new Error("Keyed service received a singleton lifecycle update");
				case "spawned":
					this.#spawn(update.instance, context);
					break;
				case "closed": {
					const instance = this.#instances.get(update.instance.key);
					if (instance?.generation === update.instance.generation) this.#instances.remove(instance);
					break;
				}
				case "state": {
					if (update.instance === undefined) throw new Error("Keyed state update has no instance address");
					const instance = this.#instances.get(update.instance.key);
					if (instance?.generation !== update.instance.generation) return;
					instance.facade.update(update.member, update.sequence, update.ops, context);
					break;
				}
			}
		} catch (error) {
			this.#reportError(toError(error));
		}
	}

	#spawn(snapshot: ServiceInstanceSnapshot, context: Context): void {
		const address = snapshot.instance;
		if (address === undefined) throw new Error("Keyed service instance snapshot has no address");
		let active = true;
		const facade = new ServiceFacade(
			this.#service.id,
			address,
			this.#transport,
			() => active && !this.#closed,
			this.#assertAccess,
			this.#reportError,
		);
		facade.install(snapshot, context);
		this.#instances.replace({
			key: address.key,
			generation: address.generation,
			service: facade.proxy,
			facade,
			deactivate: () => {
				active = false;
				facade.clear();
			},
		});
	}
}

export class RemoteServiceBindingImpl implements RemoteServiceBinding {
	readonly #transport: RemoteServiceTransport;
	readonly #allowlist = new Set<string>();
	readonly #reportError: ErrorReporter;
	readonly #modes = new Map<string, "singleton" | "keyed">();
	readonly #assertAccess: () => void;
	readonly #singletons = new Map<string, SingletonBinding>();
	readonly #keyed = new Map<string, KeyedBinding<unknown>>();
	#bound: boolean;
	#readinessRevision = 0;
	#bindingTransition = Promise.resolve();
	#disposed = false;

	constructor(options: RemoteServiceBindingOptions) {
		this.#transport = options.transport;
		const ids = options.services.map(({ id }) => id);
		if (new Set(ids).size !== ids.length) throw new TypeError("Remote service binding has duplicate service IDs");
		for (const id of ids) this.#allowlist.add(id);
		this.#reportError = options.onError ?? (() => {});
		this.#assertAccess = options.assertAccess ?? (() => {});
		this.#bound = options.bound ?? true;
	}

	use<T>(service: Service<T>): T {
		this.#assertRemotable(service);
		this.#assertAvailable(service.id, "singleton");
		let binding = this.#singletons.get(service.id);
		if (binding !== undefined) return binding.facade.proxy as T;
		binding = { facade: undefined as unknown as ServiceFacade, active: true, revision: 0 };
		binding.facade = new ServiceFacade(
			service.id,
			undefined,
			this.#transport,
			() => binding!.active && !this.#disposed && this.#bound,
			() => this.#assertHandleAccess(),
			this.#reportError,
		);
		this.#singletons.set(service.id, binding);
		this.#readinessRevision += 1;
		if (this.#bound) {
			const revision = binding.revision;
			const starting = this.#startSingleton(service.id, binding, revision);
			binding.starting = starting;
			void starting.catch((error: unknown) => {
				if (binding.active && binding.revision === revision && !this.#disposed && this.#bound) {
					this.#reportError(toError(error));
				}
			});
		}
		return binding.facade.proxy as T;
	}

	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void {
		this.#assertRemotable(service);
		this.#assertAvailable(service.id, "keyed");
		let binding = this.#keyed.get(service.id) as KeyedBinding<T> | undefined;
		if (binding === undefined) {
			binding = new KeyedBinding(
				service,
				this.#transport,
				this.#reportError,
				() => this.#assertHandleAccess(),
				() => {
					if (this.#keyed.get(service.id) !== binding) return;
					this.#keyed.delete(service.id);
					this.#readinessRevision += 1;
					void binding!.close(BACKGROUND_CONTEXT).catch(this.#reportError);
				},
				this.#bound,
			);
			this.#keyed.set(service.id, binding as KeyedBinding<unknown>);
			this.#readinessRevision += 1;
		}
		return binding.observe(handler);
	}

	async ready(context: Context): Promise<void> {
		if (this.#disposed) throw new Error("Remote service binding is disposed");
		while (true) {
			const revision = this.#readinessRevision;
			const starts = [
				this.#bindingTransition,
				...[...this.#singletons.values()].flatMap((binding) =>
					binding.starting === undefined ? [] : [binding.starting],
				),
				...[...this.#keyed.values()].map((binding) => binding.ready()),
			];
			await awaitWithContext(
				Promise.all(starts).then(() => undefined),
				context,
			);
			if (this.#disposed) throw new Error("Remote service binding is disposed");
			if (revision === this.#readinessRevision) return;
		}
	}

	async rebind(bound: boolean, context: Context): Promise<void> {
		if (this.#disposed) throw new Error("Remote service binding is disposed");
		this.#bound = bound;
		this.#readinessRevision += 1;
		const transitions: Promise<void>[] = [];
		for (const [serviceId, binding] of this.#singletons) {
			binding.revision += 1;
			binding.facade.clear();
			const subscription = binding.subscription;
			delete binding.subscription;
			const revision = binding.revision;
			const starting = (async () => {
				await subscription?.close(context);
				if (bound) await this.#startSingleton(serviceId, binding, revision);
			})();
			binding.starting = starting;
			transitions.push(starting);
		}
		for (const binding of this.#keyed.values()) transitions.push(binding.rebind(bound, context));
		const completion = (async () => {
			const results = await Promise.allSettled(transitions);
			const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (errors.length > 0)
				throw new AggregateError(
					errors.map(({ reason }) => reason),
					"Failed to rebind services",
				);
		})();
		this.#bindingTransition = completion;
		await completion;
	}

	async dispose(context: Context): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const closes: Promise<void>[] = [];
		for (const binding of this.#singletons.values()) {
			binding.active = false;
			binding.facade.clear();
			if (binding.starting) closes.push(binding.starting.catch(() => {}));
			if (binding.subscription) closes.push(Promise.resolve(binding.subscription.close(context)));
		}
		for (const binding of this.#keyed.values()) closes.push(binding.close(context));
		this.#singletons.clear();
		this.#keyed.clear();
		const results = await Promise.allSettled(closes);
		const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (errors.length > 0)
			throw new AggregateError(
				errors.map(({ reason }) => reason),
				"Failed to dispose services",
			);
	}

	async #startSingleton(serviceId: string, binding: SingletonBinding, revision: number): Promise<void> {
		const subscription = await this.#transport.subscribe(
			serviceId,
			"singleton",
			(update, context) => {
				if (!binding.active || binding.revision !== revision) return;
				try {
					if (update.type === "unavailable") {
						binding.facade.clear();
					} else if (update.type === "replaced") {
						if (update.snapshot.instance !== undefined) {
							throw new Error("Singleton replacement has an instance address");
						}
						binding.facade.install(update.snapshot, context);
					} else if (update.type === "state" && update.instance === undefined) {
						binding.facade.update(update.member, update.sequence, update.ops, context);
					}
				} catch (error) {
					this.#reportError(toError(error));
				}
			},
			BACKGROUND_CONTEXT,
		);
		if (!binding.active || this.#disposed || !this.#bound || binding.revision !== revision) {
			await subscription.close(BACKGROUND_CONTEXT);
			return;
		}
		binding.subscription = subscription;
		const snapshot = subscription.snapshot;
		if (snapshot.mode !== "singleton" || snapshot.serviceId !== serviceId || snapshot.instances.length !== 1) {
			throw new Error(`Remote service ${serviceId} returned an invalid singleton snapshot`);
		}
		binding.facade.install(snapshot.instances[0]!, serviceDeliveryContext());
		subscription.activate();
	}

	#assertHandleAccess(): void {
		if (this.#disposed) throw new Error("Remote service binding is disposed");
		this.#assertAccess();
	}

	#assertRemotable(service: { readonly id: string; readonly local: boolean }): void {
		if (service.local) throw new RemoteServiceError("service_not_allowed", `Service ${service.id} is process-local`);
	}

	#assertAvailable(serviceId: string, mode: "singleton" | "keyed"): void {
		if (this.#disposed) throw new Error("Remote service binding is disposed");
		if (!this.#allowlist.has(serviceId)) {
			throw new RemoteServiceError("service_not_allowed", `Remote service ${serviceId} is not allowlisted`);
		}
		const existing = this.#modes.get(serviceId);
		if (existing !== undefined && existing !== mode) {
			throw new RemoteServiceError(
				"service_mode_mismatch",
				`Remote service ${serviceId} is already used as ${existing}`,
			);
		}
		this.#modes.set(serviceId, mode);
	}
}

function validateMembers(members: readonly ServiceMemberSnapshot[]): ReadonlyMap<string, ServiceMemberSnapshot> {
	const result = new Map<string, ServiceMemberSnapshot>();
	for (const member of members) {
		if (member.name.length === 0 || result.has(member.name)) {
			throw new Error("Remote service has invalid member descriptions");
		}
		result.set(member.name, member);
	}
	return result;
}

function sameAddress(left: ServiceInstanceAddress | undefined, right: ServiceInstanceAddress | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.key === right.key && left.generation === right.generation;
}

function isContext(value: unknown): value is Context {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Context>;
	return typeof candidate.value === "function" && typeof candidate.toString === "function";
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
