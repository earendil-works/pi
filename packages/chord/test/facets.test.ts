import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	defineFacet,
	defineService,
	type MutableReplicatedState,
	RemoteServiceProvider,
	type RemoteServiceSource,
	type ReplicatedState,
} from "../src/index.ts";
import { createLoopbackServiceTransport } from "./helpers.ts";

interface Source {
	read(context: Context): Promise<string>;
}

interface Projection {
	read(context: Context): Promise<string>;
}

interface KeyedValue {
	read(context: Context): Promise<string>;
}

interface Watched {
	readonly state: ReplicatedState<{ value: number }>;
}

interface HostValues {
	readonly name: string;
	readonly use: string;
}

interface LocalKeyedValue {
	readonly metadata: Map<string, string>;
	read(): string;
}

interface LeftValue {
	read(context: Context): Promise<string>;
}

interface RightValue {
	read(context: Context): Promise<string>;
}

interface CombinedValue {
	read(context: Context): Promise<string>;
}

const Source = defineService<Source>("test.experimental.source");
const Projection = defineService<Projection>("test.experimental.projection");
const KeyedValue = defineService<KeyedValue>("test.experimental.keyed-value");
const Watched = defineService<Watched>("test.experimental.watched");
const HostValues = defineService<HostValues>("test.experimental.host-values", { local: true });
const LocalKeyedValue = defineService<LocalKeyedValue>("test.experimental.local-keyed-value", { local: true });
const LeftValue = defineService<LeftValue>("test.experimental.left-value");
const RightValue = defineService<RightValue>("test.experimental.right-value");
const CombinedValue = defineService<CombinedValue>("test.experimental.combined-value");

describe("facet host", () => {
	test("discovers setup dependencies before connecting stable service handles", async () => {
		const trace: string[] = [];
		let sourceHandle: Source | undefined;
		const projection = defineFacet({
			id: "projection",
			setup(env) {
				trace.push("setup projection");
				sourceHandle = env.use(Source);
				expect(() => sourceHandle!.read(BACKGROUND_CONTEXT)).toThrow(
					"Facet projection service handles cannot be used while setting_up",
				);
				env.provide(Projection, {
					read: (context) => sourceHandle!.read(context),
				});
				env.onActivate(() => {
					trace.push("activate projection");
				});
				env.onDeactivate(() => {
					trace.push("dispose projection");
				});
			},
		});
		const source = defineFacet({
			id: "source",
			setup(env) {
				trace.push("setup source");
				env.provide(Source, {
					async read() {
						return "value";
					},
				});
				env.onActivate(() => {
					trace.push("activate source");
				});
				env.onDeactivate(() => {
					trace.push("dispose source");
				});
			},
		});
		const host = await createFacetHost({ facets: [projection, source] });

		expect(trace).toEqual(["setup projection", "setup source", "activate source", "activate projection"]);
		expect(await sourceHandle!.read(BACKGROUND_CONTEXT)).toBe("value");
		expect(await host.services.use(Projection).read(BACKGROUND_CONTEXT)).toBe("value");

		await host.dispose();
		expect(trace.slice(-2)).toEqual(["dispose projection", "dispose source"]);
	});

	test("connects keyed observations only when the observing facet activates", async () => {
		const trace: string[] = [];
		const observer = defineFacet({
			id: "observer",
			setup(env) {
				env.observe(KeyedValue, async (service, context) => {
					trace.push(`observe ${await service.read(context)}`);
				});
				env.onActivate(() => {
					trace.push("activate observer");
				});
			},
		});
		const provider = defineFacet({
			id: "provider",
			setup(env) {
				const values = env.provideMany(KeyedValue);
				env.onActivate(() => {
					trace.push("activate provider");
					values.spawn("one", {
						async read() {
							return "one";
						},
					});
				});
			},
		});
		const host = await createFacetHost({ facets: [observer, provider] });
		await vi.waitFor(() => expect(trace).toContain("observe one"));

		expect(trace).toEqual(["activate provider", "activate observer", "observe one"]);
		const remoteServices = createRemoteServiceBinding({
			services: [KeyedValue],
			transport: createLoopbackServiceTransport(host.services),
		});
		const remoteValues: string[] = [];
		remoteServices.observe(KeyedValue, async (service, context) => {
			remoteValues.push(await service.read(context));
		});
		await remoteServices.ready(BACKGROUND_CONTEXT);
		await vi.waitFor(() => expect(remoteValues).toEqual(["one"]));

		await remoteServices.dispose(BACKGROUND_CONTEXT);
		await host.dispose();
	});

	test("routes remotely exposable keyed services through the host provider", async () => {
		const observed: Array<{ service: KeyedValue; context: Context }> = [];
		const consumer = defineFacet({
			id: "remote-keyed-consumer",
			setup(env) {
				env.observe(KeyedValue, (service, context) => {
					observed.push({ service, context });
				});
			},
		});
		const provider = (value: string) =>
			defineFacet({
				id: "remote-keyed-provider",
				setup(env) {
					const values = env.provideMany(KeyedValue);
					env.onActivate(() => {
						values.spawn("current", {
							async read() {
								return value;
							},
						});
					});
				},
			});
		const host = await createFacetHost({ facets: [consumer, provider("A")] });
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		const first = observed[0]!;
		await expect(first.service.read(first.context)).resolves.toBe("A");

		await host.reload([provider("B")]);
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		expect(first.context.abortSignal?.aborted).toBe(true);
		expect(() => first.service.read(first.context)).toThrow("observation is closed");
		await expect(observed[1]!.service.read(observed[1]!.context)).resolves.toBe("B");

		await host.dispose();
		expect(observed[1]!.context.abortSignal?.aborted).toBe(true);
	});

	test("terminates the host when keyed replacement publication fails", async () => {
		const failure = new Error("spawn publication failed");
		const provider = (value: string) =>
			defineFacet({
				id: "failing-keyed-provider",
				setup(env) {
					const values = env.provideMany(KeyedValue);
					env.onActivate(() => {
						values.spawn("current", {
							async read() {
								return value;
							},
						});
					});
				},
			});
		const host = await createFacetHost({ facets: [provider("A")] });
		const subscription = host.services.subscribe(KeyedValue.id, "keyed", (update) => {
			if (update.type === "spawned") throw failure;
		});
		subscription.activate();

		await expect(host.reload([provider("B")])).rejects.toThrow("Facet reload failed after cutover");
		await expect(host.reload([])).rejects.toThrow("Facet host cannot reload while dead");
		expect(() => host.services.use(KeyedValue)).toThrow("Remote service provider is disposed");
		await host.dispose();
	});

	test("terminates the host when keyed retirement publication fails", async () => {
		const failure = new Error("close publication failed");
		const provider = (value: string) =>
			defineFacet({
				id: "failing-keyed-retirement-provider",
				setup(env) {
					const values = env.provideMany(KeyedValue);
					env.onActivate(() => {
						values.spawn("current", {
							async read() {
								return value;
							},
						});
					});
				},
			});
		const host = await createFacetHost({ facets: [provider("A")] });
		const subscription = host.services.subscribe(KeyedValue.id, "keyed", (update) => {
			if (update.type === "closed") throw failure;
		});
		subscription.activate();

		await expect(host.reload([provider("B")])).rejects.toThrow("Facet reload failed after cutover");
		await expect(host.reload([])).rejects.toThrow("Facet host cannot reload while dead");
		await host.dispose();
	});

	test("keeps unrestricted local keyed services process-local across provider reloads", async () => {
		const observed: Array<{ service: LocalKeyedValue; context: Context }> = [];
		const consumer = defineFacet({
			id: "local-keyed-consumer",
			setup(env) {
				env.observe(LocalKeyedValue, (service, context) => {
					observed.push({ service, context });
				});
			},
		});
		const provider = (value: string) =>
			defineFacet({
				id: "local-keyed-provider",
				setup(env) {
					const values = env.provideMany(LocalKeyedValue);
					env.onActivate(() => {
						values.spawn("current", {
							metadata: new Map([["value", value]]),
							read: () => value,
						});
					});
				},
			});
		const host = await createFacetHost({ facets: [consumer, provider("A")] });
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		const first = observed[0]!;
		expect(first.service.read()).toBe("A");
		expect(first.service.metadata.get("value")).toBe("A");
		expect(host.services.catalogue).not.toContainEqual({ serviceId: LocalKeyedValue.id, mode: "keyed" });
		expect(() => host.services.use(LocalKeyedValue)).toThrow("process-local");

		await host.reload([provider("B")]);
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		expect(first.context.abortSignal?.aborted).toBe(true);
		expect(() => first.service.read()).toThrow(`Keyed service ${LocalKeyedValue.id} observation is closed`);
		expect(observed[1]!.service.read()).toBe("B");
		expect(observed[1]!.service.metadata.get("value")).toBe("B");

		await host.dispose();
		expect(observed[1]!.context.abortSignal?.aborted).toBe(true);
	});

	test("keeps remotely exposable local state replicas stable across provider reloads", async () => {
		const sources: MutableReplicatedState<{ value: number }>[] = [];
		const revisions: number[] = [];
		let watched: Watched | undefined;
		const consumer = defineFacet({
			id: "state-consumer",
			setup(env) {
				watched = env.use(Watched);
				env.onActivate(() => {
					env.own(watched!.state.subscribe(({ value }) => revisions.push(value)));
				});
			},
		});
		const provider = (value: number) =>
			defineFacet({
				id: "state-provider",
				setup(env) {
					const state = env.replicatedState({ value });
					sources.push(state);
					env.provide(Watched, { state });
				},
			});
		const host = await createFacetHost({ facets: [consumer, provider(1)] });
		const retainedState = watched!.state;
		expect(retainedState.value).toEqual({ value: 1 });
		expect(revisions).toEqual([1]);

		await host.reload([provider(2)]);
		expect(watched!.state).toBe(retainedState);
		expect(retainedState.value).toEqual({ value: 2 });
		expect(revisions).toEqual([1, 2]);
		sources[0]!.state.value = 3;
		sources[0]!.publish(BACKGROUND_CONTEXT);
		expect(retainedState.value).toEqual({ value: 2 });
		expect(revisions).toEqual([1, 2]);

		await host.dispose();
		expect(() => retainedState.value).toThrow("Facet state-consumer service handles cannot be used while dead");
	});

	test("scopes singleton service views to each facet lifecycle", async () => {
		const consumerHandles: Source[] = [];
		const cleanupValues: string[] = [];
		let peerHandle: Source | undefined;
		const consumer = (generation: string) =>
			defineFacet({
				id: "scoped-consumer",
				setup(env) {
					const source = env.use(Source);
					expect(env.use(Source)).toBe(source);
					consumerHandles.push(source);
					expect(() => source.read(BACKGROUND_CONTEXT)).toThrow(
						"Facet scoped-consumer service handles cannot be used while setting_up",
					);
					env.onDeactivate(async () => {
						cleanupValues.push(`${generation}:${await source.read(BACKGROUND_CONTEXT)}`);
					});
				},
			});
		const peer = defineFacet({
			id: "peer-consumer",
			setup(env) {
				peerHandle = env.use(Source);
			},
		});
		const provider = defineFacet({
			id: "scoped-provider",
			setup(env) {
				env.provide(Source, {
					async read() {
						return "value";
					},
				});
			},
		});
		const host = await createFacetHost({ facets: [consumer("A"), peer, provider] });
		expect(consumerHandles[0]).not.toBe(peerHandle);
		const retainedOldRead = consumerHandles[0]!.read;

		await host.reload([consumer("B")]);
		expect(cleanupValues).toEqual(["A:value"]);
		expect(Object.is(consumerHandles[1], consumerHandles[0])).toBe(false);
		expect(() => consumerHandles[0]!.read(BACKGROUND_CONTEXT)).toThrow(
			"Facet scoped-consumer service handles cannot be used while dead",
		);
		expect(() => retainedOldRead(BACKGROUND_CONTEXT)).toThrow(
			"Facet scoped-consumer service handles cannot be used while dead",
		);
		await expect(consumerHandles[1]!.read(BACKGROUND_CONTEXT)).resolves.toBe("value");
		await expect(peerHandle!.read(BACKGROUND_CONTEXT)).resolves.toBe("value");

		await host.dispose();
		expect(cleanupValues).toEqual(["A:value", "B:value"]);
		expect(() => consumerHandles[1]!.read(BACKGROUND_CONTEXT)).toThrow(
			"Facet scoped-consumer service handles cannot be used while dead",
		);
		expect(() => peerHandle!.read(BACKGROUND_CONTEXT)).toThrow(
			"Facet peer-consumer service handles cannot be used while dead",
		);
	});

	test("owns resources registered during activation", async () => {
		let state: MutableReplicatedState<{ value: number }> | undefined;
		let deliveries = 0;
		const consumer = defineFacet({
			id: "consumer",
			setup(env) {
				const watched = env.use(Watched);
				env.onActivate(() => {
					env.own(
						watched.state.subscribe(() => {
							deliveries += 1;
						}),
					);
				});
			},
		});
		const provider = defineFacet({
			id: "provider",
			setup(env) {
				state = env.replicatedState({ value: 0 });
				env.provide(Watched, { state });
			},
		});
		const host = await createFacetHost({ facets: [consumer, provider] });
		expect(deliveries).toBe(1);
		state!.state.value = 1;
		state!.publish(BACKGROUND_CONTEXT);
		expect(deliveries).toBe(2);

		await host.dispose();
		state!.state.value = 2;
		state!.publish(BACKGROUND_CONTEXT);
		expect(deliveries).toBe(2);
	});

	test("provides arbitrary host services through the facet graph", async () => {
		const values: HostValues = { name: "session", use: "host value" };
		const consumer = defineFacet({
			id: "host-service-consumer",
			setup(env) {
				const hostValues = env.use(HostValues);
				expect(() => hostValues.use).toThrow(
					"Facet host-service-consumer service handles cannot be used while setting_up",
				);
				env.onActivate(() => {
					expect(hostValues).not.toBe(values);
					expect(hostValues.name).toBe("session");
					expect(hostValues.use).toBe("host value");
				});
			},
		});
		const provider = defineFacet({
			id: "host-service-provider",
			setup(env) {
				env.provide(HostValues, values);
			},
		});
		const host = await createFacetHost({ facets: [consumer, provider] });
		expect(() => host.services.use(HostValues)).toThrow("Service test.experimental.host-values is process-local");
		await host.dispose();
	});

	test("combines connected services and facet-provided services in one host", async () => {
		const leftProvider = new RemoteServiceProvider([LeftValue]);
		leftProvider.provide(LeftValue, {
			async read() {
				return "left";
			},
		});
		const rightProvider = new RemoteServiceProvider([RightValue]);
		rightProvider.provide(RightValue, {
			async read() {
				return "right";
			},
		});
		const leftNamespace = createRemoteServiceBinding({
			services: [LeftValue],
			transport: createLoopbackServiceTransport(leftProvider),
			bound: false,
		});
		const rightNamespace = createRemoteServiceBinding({
			services: [RightValue],
			transport: createLoopbackServiceTransport(rightProvider),
			bound: false,
		});
		const serviceSources = [
			{ namespace: leftNamespace, provider: leftProvider },
			{ namespace: rightNamespace, provider: rightProvider },
		].map(({ namespace, provider }) => {
			const ready = namespace.ready.bind(namespace);
			return Object.assign(namespace, {
				acceptsUnavailableServices: false,
				async catalogue() {
					return provider.catalogue;
				},
				open() {
					return namespace;
				},
				async ready(context: Context) {
					await namespace.rebind(true, context);
					await ready(context);
				},
			});
		});
		const facet = defineFacet({
			id: "combined",
			setup(env) {
				const left = env.use(LeftValue);
				const right = env.use(RightValue);
				env.provide(CombinedValue, {
					async read(context) {
						return `${await left.read(context)} ${await right.read(context)}`;
					},
				});
			},
		});

		const host = await createFacetHost({ facets: [facet], serviceSources });
		await expect(host.services.use(CombinedValue).read(BACKGROUND_CONTEXT)).resolves.toBe("left right");

		await host.dispose();
		await Promise.all([leftNamespace.dispose(BACKGROUND_CONTEXT), rightNamespace.dispose(BACKGROUND_CONTEXT)]);
		leftProvider.dispose();
		rightProvider.dispose();
	});

	test("rejects a service offered by multiple sources", async () => {
		const duplicate = {
			acceptsUnavailableServices: false,
			async catalogue() {
				return [{ serviceId: LeftValue.id, mode: "singleton" as const }];
			},
			open() {
				throw new Error("Ambiguous sources must not open");
			},
		} satisfies RemoteServiceSource;
		const consumer = defineFacet({
			id: "duplicate-consumer",
			setup(env) {
				env.use(LeftValue);
			},
		});
		await expect(createFacetHost({ facets: [consumer], serviceSources: [duplicate, duplicate] })).rejects.toThrow(
			`Facet host service ${LeftValue.id} is offered by more than one source`,
		);
	});

	test("reopens source bindings from changed catalogues for a replacement generation", async () => {
		const leftProvider = new RemoteServiceProvider([LeftValue]);
		leftProvider.provide(LeftValue, {
			async read() {
				return "left";
			},
		});
		const rightProvider = new RemoteServiceProvider([RightValue]);
		rightProvider.provide(RightValue, {
			async read() {
				return "right";
			},
		});
		let currentProvider = leftProvider;
		let opened = 0;
		let disposed = 0;
		const source = {
			acceptsUnavailableServices: false,
			async catalogue() {
				return currentProvider.catalogue;
			},
			open(options) {
				opened += 1;
				const namespace = createRemoteServiceBinding({
					services: options.services,
					transport: createLoopbackServiceTransport(currentProvider),
					bound: false,
					assertAccess: options.assertAccess,
					onError: options.onError,
				});
				const ready = namespace.ready.bind(namespace);
				const dispose = namespace.dispose.bind(namespace);
				return Object.assign(namespace, {
					async ready(context: Context) {
						await namespace.rebind(true, context);
						await ready(context);
					},
					async dispose(context: Context) {
						disposed += 1;
						await dispose(context);
					},
				});
			},
		} satisfies RemoteServiceSource;
		const values: string[] = [];
		const leftConsumer = defineFacet({
			id: "left-consumer",
			setup(env) {
				const left = env.use(LeftValue);
				env.onActivate(async () => {
					values.push(await left.read(BACKGROUND_CONTEXT));
				});
			},
		});
		const first = await createFacetHost({ facets: [leftConsumer], serviceSources: [source] });
		await first.dispose();

		currentProvider = rightProvider;
		const rightConsumer = defineFacet({
			id: "right-consumer",
			setup(env) {
				const right = env.use(RightValue);
				env.onActivate(async () => {
					values.push(await right.read(BACKGROUND_CONTEXT));
				});
			},
		});
		const second = await createFacetHost({ facets: [rightConsumer], serviceSources: [source] });
		await second.dispose();

		expect(values).toEqual(["left", "right"]);
		expect(opened).toBe(2);
		expect(disposed).toBe(2);
		leftProvider.dispose();
		rightProvider.dispose();
	});

	test("rejects missing dependencies, cycles, and asynchronous setup", async () => {
		let activated = false;
		const missing = defineFacet({
			id: "missing",
			setup(env) {
				env.use(Source);
				env.onActivate(() => {
					activated = true;
				});
			},
		});
		await expect(createFacetHost({ facets: [missing] })).rejects.toThrow(
			"Facet missing requires local/test.experimental.source/singleton, but no facet provides it",
		);
		expect(activated).toBe(false);

		const first = defineFacet({
			id: "first",
			setup(env) {
				env.use(Projection);
				env.provide(Source, {
					async read() {
						return "first";
					},
				});
			},
		});
		const second = defineFacet({
			id: "second",
			setup(env) {
				env.use(Source);
				env.provide(Projection, {
					async read() {
						return "second";
					},
				});
			},
		});
		await expect(createFacetHost({ facets: [first, second] })).rejects.toThrow(
			"Facet dependency cycle: first, second",
		);

		const asynchronous = defineFacet({
			id: "asynchronous",
			async setup() {
				await Promise.resolve();
			},
		});
		await expect(createFacetHost({ facets: [asynchronous] })).rejects.toThrow(
			"Facet asynchronous setup must be synchronous",
		);
	});
});
