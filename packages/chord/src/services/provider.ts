import type {
	Context,
	JsonValue,
	RemoteServiceContract,
	Service,
	ServiceCall,
	ServiceCatalogueEntry,
	ServiceInstanceAddress,
	ServiceInstanceSnapshot,
	ServiceMemberSnapshot,
	ServiceMode,
	ServiceProviderUpdate,
	ServiceSubscription,
	ServiceSubscriptionSnapshot,
} from "../types.ts";
import { RemoteServiceError } from "./errors.ts";
import { serviceDeliveryContext } from "./state.ts";
import { getReplicatedStateInternals, type ReplicatedStateInternals } from "./state-internals.ts";
import { decodeServiceControlCall } from "./wire.ts";

type RemoteMethod = (...args: unknown[]) => unknown;

type InstanceMember =
	| { readonly kind: "method"; readonly method: RemoteMethod }
	| { readonly kind: "state"; readonly state: ReplicatedStateInternals };

type ServiceMemberKind = InstanceMember["kind"];

interface ClassifiedRemoteServiceImplementation {
	readonly implementation: object;
	readonly members: Map<string, InstanceMember>;
}

interface ProviderInstance {
	readonly address?: ServiceInstanceAddress;
	readonly implementation: object;
	readonly members: ReadonlyMap<string, InstanceMember>;
	readonly removeMemberListeners: readonly (() => void)[];
	active: boolean;
}

interface ProviderSubscriber {
	readonly listener: (update: ServiceProviderUpdate, context: Context) => void;
	readonly buffer: { readonly update: ServiceProviderUpdate; readonly context: Context }[];
	active: boolean;
	terminated: boolean;
	closed: boolean;
}

interface ServiceProviderDefinition {
	readonly service: { readonly id: string; readonly local?: boolean };
	readonly mode: ServiceMode;
}

interface ServiceRegistration {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	singleton?: ProviderInstance;
	singletonShape?: ReadonlyMap<string, ServiceMemberKind>;
	readonly instances: Map<string, ProviderInstance>;
	readonly generations: Map<string, number>;
	readonly subscribers: Set<ProviderSubscriber>;
}

export type ServiceUpdatePublisher = (
	subscriptionId: string,
	update: ServiceProviderUpdate,
	context: Context,
) => void | Promise<void>;

/** Hosts one provider for one remote consumer and owns that consumer's subscriptions. */
export interface RemoteServiceEndpoint {
	invoke(call: ServiceCall, publish: ServiceUpdatePublisher, context: Context): Promise<JsonValue | undefined>;
	dispose(): void;
}

export class RemoteServiceProvider {
	readonly #catalogue: readonly ServiceCatalogueEntry[];
	readonly #registrations = new Map<string, ServiceRegistration>();
	#disposed = false;

	constructor(entries: readonly (ServiceProviderDefinition | { readonly id: string })[]) {
		const definitions = entries.map(
			(entry): ServiceProviderDefinition => ("service" in entry ? entry : { service: entry, mode: "singleton" }),
		);
		for (const { service } of definitions) {
			if ("local" in service && service.local === true) {
				throw new TypeError(`Local service ${service.id} cannot be published remotely`);
			}
		}
		const ids = definitions.map(({ service }) => service.id);
		if (new Set(ids).size !== ids.length) throw new TypeError("Remote service catalogue contains duplicate IDs");
		this.#catalogue = Object.freeze(
			definitions.map(({ service, mode }) => Object.freeze({ serviceId: service.id, mode })),
		);
		for (const { service, mode } of definitions) {
			this.#registrations.set(service.id, {
				serviceId: service.id,
				mode,
				instances: new Map(),
				generations: new Map(),
				subscribers: new Set(),
			});
		}
	}

	get catalogue(): readonly ServiceCatalogueEntry[] {
		return this.#catalogue;
	}

	provide<T>(service: Service<T>, implementation: NoInfer<RemoteServiceContract<T>>): void {
		this.#assertActive();
		this.#assertRemotable(service);
		this.#assertAllowed(service.id);
		const registration = this.#registration(service.id, "singleton");
		if (registration.singleton !== undefined) {
			throw new RemoteServiceError("service_mode_mismatch", `Remote service ${service.id} already has a provider`);
		}
		const classified = classifyRemoteServiceImplementation(registration.serviceId, implementation);
		const shape = serviceMemberShape(classified.members);
		this.#assertSingletonShape(registration, shape);
		registration.singleton = this.#createInstance(registration, classified, undefined);
		registration.singletonShape = shape;
	}

	/** Disconnect one singleton while preserving active subscriptions and remote facades. */
	withdraw<T>(service: Service<T>): void {
		this.#assertActive();
		this.#assertRemotable(service);
		this.#assertAllowed(service.id);
		const registration = this.#registration(service.id, "singleton");
		const previous = registration.singleton;
		if (previous === undefined) return;
		previous.active = false;
		for (const remove of previous.removeMemberListeners) remove();
		delete registration.singleton;
		this.#emit(registration, { type: "unavailable" });
	}

	/** Check a singleton replacement without changing the active provider. */
	validateReplacement<T>(service: Service<T>, implementation: NoInfer<RemoteServiceContract<T>>): void {
		this.#assertActive();
		this.#assertRemotable(service);
		this.#assertAllowed(service.id);
		const registration = this.#registration(service.id, "singleton");
		const classified = classifyRemoteServiceImplementation(registration.serviceId, implementation);
		this.#assertSingletonShape(registration, serviceMemberShape(classified.members));
	}

	/** Replace one singleton without making its stable remote facade unavailable. */
	replace<T>(service: Service<T>, implementation: NoInfer<RemoteServiceContract<T>>): void {
		this.#assertActive();
		this.#assertRemotable(service);
		this.#assertAllowed(service.id);
		const registration = this.#registration(service.id, "singleton");
		const classified = classifyRemoteServiceImplementation(registration.serviceId, implementation);
		const shape = serviceMemberShape(classified.members);
		this.#assertSingletonShape(registration, shape);
		const replacement = this.#createInstance(registration, classified, undefined);
		const previous = registration.singleton;
		if (previous !== undefined) {
			previous.active = false;
			for (const remove of previous.removeMemberListeners) remove();
		}
		registration.singleton = replacement;
		registration.singletonShape = shape;
		this.#emit(registration, { type: "replaced", snapshot: this.#snapshotInstance(replacement) });
	}

	use<T>(service: Service<T>): T {
		this.#assertActive();
		this.#assertRemotable(service);
		this.#assertAllowed(service.id);
		const registration = this.#registrations.get(service.id);
		if (registration?.mode !== "singleton" || registration.singleton === undefined) {
			throw new RemoteServiceError("service_not_found", `Remote service ${service.id} has no local provider`);
		}
		return registration.singleton.implementation as T;
	}

	spawn<T>(service: Service<T>, key: string, implementation: NoInfer<RemoteServiceContract<T>>): () => void {
		this.#assertActive();
		this.#assertRemotable(service);
		this.#assertAllowed(service.id);
		if (key.length === 0) throw new TypeError("Remote service instance key must not be empty");
		const registration = this.#registration(service.id, "keyed");
		if (registration.instances.has(key)) {
			throw new RemoteServiceError(
				"service_mode_mismatch",
				`Remote service ${service.id} already has a live instance with key ${key}`,
			);
		}
		const generation = (registration.generations.get(key) ?? 0) + 1;
		registration.generations.set(key, generation);
		const address = { key, generation } satisfies ServiceInstanceAddress;
		const classified = classifyRemoteServiceImplementation(registration.serviceId, implementation);
		const instance = this.#createInstance(registration, classified, address);
		registration.instances.set(key, instance);
		this.#emit(registration, { type: "spawned", instance: this.#snapshotInstance(instance) });
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			if (registration.instances.get(key) !== instance) return;
			instance.active = false;
			for (const remove of instance.removeMemberListeners) remove();
			registration.instances.delete(key);
			this.#emit(registration, { type: "closed", instance: address });
		};
	}

	async invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined> {
		this.#assertActive();
		this.#assertAllowed(call.serviceId);
		const registration = this.#registrations.get(call.serviceId);
		if (registration === undefined) {
			throw new RemoteServiceError("service_not_found", `Unknown remote service ${call.serviceId}`);
		}
		const instance = this.#resolveInstance(registration, call.instance);
		const member = instance.members.get(call.member);
		if (member === undefined) {
			throw new RemoteServiceError(
				"service_member_not_found",
				`Unknown remote service member ${call.serviceId}.${call.member}`,
			);
		}
		if (member.kind !== "method") {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${call.serviceId}.${call.member} is not a method`,
			);
		}
		const result: unknown = await Reflect.apply(member.method, instance.implementation, [...call.args, context]);
		return result as JsonValue | undefined;
	}

	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
	): ServiceSubscription {
		this.#assertActive();
		this.#assertAllowed(serviceId);
		const registration = this.#registration(serviceId, mode);
		if (registration.mode === "singleton" && registration.singleton === undefined) {
			throw new RemoteServiceError("service_not_found", `Remote service ${serviceId} has no provider`);
		}
		const subscriber: ProviderSubscriber = {
			listener,
			buffer: [],
			active: false,
			terminated: false,
			closed: false,
		};
		this.#publishPending(registration);
		registration.subscribers.add(subscriber);
		const snapshot = this.#snapshot(registration);
		return {
			snapshot,
			activate: () => {
				if (subscriber.closed || subscriber.active) return;
				subscriber.active = true;
				const errors: unknown[] = [];
				try {
					for (const entry of subscriber.buffer.splice(0)) {
						try {
							listener(entry.update, entry.context);
						} catch (error) {
							errors.push(error);
						}
					}
				} finally {
					if (subscriber.terminated) subscriber.closed = true;
				}
				throwCollectedErrors(errors, "Failed to activate remote service subscription");
			},
			close: () => {
				if (subscriber.closed) return;
				subscriber.closed = true;
				subscriber.buffer.length = 0;
				registration.subscribers.delete(subscriber);
			},
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const errors: unknown[] = [];
		for (const registration of this.#registrations.values()) {
			const singleton = registration.singleton;
			if (singleton !== undefined) {
				singleton.active = false;
				for (const remove of singleton.removeMemberListeners) remove();
				delete registration.singleton;
				try {
					this.#emit(registration, { type: "unavailable" });
				} catch (error) {
					errors.push(error);
				}
			}
			for (const [key, instance] of [...registration.instances]) {
				instance.active = false;
				for (const remove of instance.removeMemberListeners) remove();
				registration.instances.delete(key);
				try {
					this.#emit(registration, { type: "closed", instance: instance.address! });
				} catch (error) {
					errors.push(error);
				}
			}
			for (const subscriber of registration.subscribers) {
				if (subscriber.active) {
					subscriber.closed = true;
					subscriber.buffer.length = 0;
				} else {
					subscriber.terminated = true;
				}
			}
			registration.subscribers.clear();
		}
		this.#registrations.clear();
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose remote service provider");
	}

	#registration(serviceId: string, mode: ServiceMode): ServiceRegistration {
		const registration = this.#registrations.get(serviceId);
		if (registration === undefined) {
			throw new RemoteServiceError("service_not_found", `Unknown remote service ${serviceId}`);
		}
		if (registration.mode !== mode) {
			throw new RemoteServiceError(
				"service_mode_mismatch",
				`Remote service ${serviceId} is ${registration.mode}, not ${mode}`,
			);
		}
		return registration;
	}

	#createInstance(
		registration: ServiceRegistration,
		classified: ClassifiedRemoteServiceImplementation,
		address: ServiceInstanceAddress | undefined,
	): ProviderInstance {
		const removeMemberListeners: (() => void)[] = [];
		const instance: ProviderInstance = {
			...(address === undefined ? {} : { address }),
			implementation: classified.implementation,
			members: classified.members,
			removeMemberListeners,
			active: true,
		};
		for (const [name, member] of classified.members) {
			if (member.kind !== "state") continue;
			removeMemberListeners.push(
				member.state.subscribe((ops, sequence, context) => {
					if (!instance.active) return;
					this.#emit(
						registration,
						{
							type: "state",
							...(address === undefined ? {} : { instance: address }),
							member: name,
							sequence,
							ops,
						},
						context,
					);
				}),
			);
		}
		return instance;
	}

	#assertSingletonShape(registration: ServiceRegistration, replacement: ReadonlyMap<string, ServiceMemberKind>): void {
		const current = registration.singletonShape;
		if (current === undefined || sameServiceMemberShape(current, replacement)) return;
		throw new RemoteServiceError(
			"service_member_mismatch",
			`Remote service ${registration.serviceId} replacement must preserve its member shape`,
		);
	}

	#resolveInstance(registration: ServiceRegistration, address: ServiceInstanceAddress | undefined): ProviderInstance {
		if (registration.mode === "singleton") {
			if (address !== undefined) {
				throw new RemoteServiceError(
					"service_mode_mismatch",
					`Remote service ${registration.serviceId} is singleton`,
				);
			}
			if (registration.singleton === undefined) {
				throw new RemoteServiceError(
					"service_not_found",
					`Remote service ${registration.serviceId} has no provider`,
				);
			}
			return registration.singleton;
		}
		if (address === undefined) {
			throw new RemoteServiceError("service_mode_mismatch", `Remote service ${registration.serviceId} is keyed`);
		}
		const instance = registration.instances.get(address.key);
		if (instance === undefined) {
			throw new RemoteServiceError(
				"service_instance_not_found",
				`Remote service ${registration.serviceId} has no instance ${address.key}`,
			);
		}
		if (instance.address?.generation !== address.generation) {
			throw new RemoteServiceError(
				"service_stale_instance",
				`Remote service ${registration.serviceId} instance ${address.key} is stale`,
			);
		}
		return instance;
	}

	#publishPending(registration: ServiceRegistration): void {
		const context = serviceDeliveryContext();
		const instances =
			registration.mode === "singleton"
				? registration.singleton === undefined
					? []
					: [registration.singleton]
				: registration.instances.values();
		for (const instance of instances) {
			for (const member of instance.members.values()) {
				if (member.kind === "state") member.state.publish(context);
			}
		}
	}

	#snapshot(registration: ServiceRegistration): ServiceSubscriptionSnapshot {
		const instances =
			registration.mode === "singleton"
				? registration.singleton
					? [this.#snapshotInstance(registration.singleton)]
					: []
				: [...registration.instances.values()]
						.sort((left, right) => left.address!.key.localeCompare(right.address!.key))
						.map((instance) => this.#snapshotInstance(instance));
		return { serviceId: registration.serviceId, mode: registration.mode, instances };
	}

	#snapshotInstance(instance: ProviderInstance): ServiceInstanceSnapshot {
		const members: ServiceMemberSnapshot[] = [];
		for (const [name, member] of instance.members) {
			if (member.kind === "method") {
				members.push({ name, kind: "method" });
			} else {
				members.push({
					name,
					kind: "state",
					sequence: member.state.sequence,
					ops: [["r", member.state.value as JsonValue]],
				});
			}
		}
		return {
			...(instance.address === undefined ? {} : { instance: instance.address }),
			members,
		};
	}

	#emit(registration: ServiceRegistration, update: ServiceProviderUpdate, context?: Context): void {
		if (registration.subscribers.size === 0) return;
		const deliveryContext = context ?? serviceDeliveryContext();
		const errors: unknown[] = [];
		for (const subscriber of registration.subscribers) {
			if (subscriber.closed) continue;
			const entry = { update, context: deliveryContext };
			if (!subscriber.active) {
				subscriber.buffer.push(entry);
				continue;
			}
			try {
				subscriber.listener(entry.update, entry.context);
			} catch (error) {
				errors.push(error);
			}
		}
		throwCollectedErrors(errors, `Failed to publish remote service ${registration.serviceId} update`);
	}

	#assertRemotable(service: { readonly id: string; readonly local: boolean }): void {
		if (service.local) throw new RemoteServiceError("service_not_allowed", `Service ${service.id} is process-local`);
	}

	#assertAllowed(serviceId: string): void {
		if (!this.#registrations.has(serviceId)) {
			throw new RemoteServiceError("service_not_allowed", `Remote service ${serviceId} is not allowlisted`);
		}
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Remote service provider is disposed");
	}
}

export function createRemoteServiceEndpoint(provider: RemoteServiceProvider): RemoteServiceEndpoint {
	const subscriptions = new Map<string, ServiceSubscription>();
	let disposed = false;

	return {
		async invoke(call, publish, context) {
			if (disposed) throw new Error("Remote service endpoint is disposed");
			const control = decodeServiceControlCall(call);
			if (control?.type === "catalogue") return provider.catalogue as unknown as JsonValue;
			if (control?.type === "subscribe") {
				if (subscriptions.has(control.subscriptionId)) {
					throw new Error("Service subscription ID is already active");
				}
				const subscription = provider.subscribe(control.serviceId, control.mode, (update, updateContext) => {
					void Promise.resolve(publish(control.subscriptionId, update, updateContext)).catch(() => {});
				});
				subscriptions.set(control.subscriptionId, subscription);
				subscription.activate();
				return subscription.snapshot as unknown as JsonValue;
			}
			if (control?.type === "unsubscribe") {
				const subscription = subscriptions.get(control.subscriptionId);
				if (subscription === undefined) throw new Error("Service subscription was not found");
				subscription.close();
				subscriptions.delete(control.subscriptionId);
				return undefined;
			}
			return provider.invoke(call, context);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const subscription of subscriptions.values()) subscription.close();
			subscriptions.clear();
		},
	};
}

export function validateRemoteServiceImplementation(serviceId: string, implementation: unknown): void {
	void classifyRemoteServiceImplementation(serviceId, implementation);
}

function classifyRemoteServiceImplementation(
	serviceId: string,
	implementation: unknown,
): ClassifiedRemoteServiceImplementation {
	if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
		throw new TypeError(`Remote service ${serviceId} implementation must be an object`);
	}
	const members = new Map<string, InstanceMember>();
	for (const name of Object.keys(implementation).sort()) {
		const descriptor = Object.getOwnPropertyDescriptor(implementation, name);
		if (descriptor === undefined || !("value" in descriptor)) {
			throw new TypeError(`Remote service member ${serviceId}.${name} must be a data property`);
		}
		if (typeof descriptor.value === "function") {
			members.set(name, { kind: "method", method: descriptor.value as RemoteMethod });
			continue;
		}
		const state = getReplicatedStateInternals(descriptor.value);
		if (state !== undefined) {
			members.set(name, { kind: "state", state });
			continue;
		}
		throw new TypeError(`Remote service member ${serviceId}.${name} is not remotely exposable`);
	}
	if (members.size === 0) throw new TypeError(`Remote service ${serviceId} has no members`);
	return { implementation, members };
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

function serviceMemberShape(members: ReadonlyMap<string, InstanceMember>): ReadonlyMap<string, ServiceMemberKind> {
	return new Map([...members].map(([name, member]) => [name, member.kind]));
}

function sameServiceMemberShape(
	left: ReadonlyMap<string, ServiceMemberKind>,
	right: ReadonlyMap<string, ServiceMemberKind>,
): boolean {
	return left.size === right.size && [...left].every(([name, kind]) => right.get(name) === kind);
}
