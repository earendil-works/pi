import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context/index.ts";
import {
	type Context,
	createRemoteServiceBinding,
	defineService,
	type JsonValue,
	RemoteServiceProvider,
	type RemoteServiceTransport,
	type ReplicatedState,
	replicatedState,
} from "../src/index.ts";
import { createLoopbackServiceTransport } from "./helpers.ts";

type ModelRef = { provider: string; modelId: string };
type ModelsState = {
	selected: ModelRef | null;
	revision: number;
};
interface Models {
	readonly state: ReplicatedState<ModelsState>;
	select(model: ModelRef, context: Context): Promise<void>;
}

const Models = defineService<Models>("test.models");

type Question = { question: string };
interface QuestionDialogs {
	readonly request: ReplicatedState<Question>;
	submit(answer: string, context: Context): Promise<{ accepted: boolean }>;
}

const QuestionDialogs = defineService<QuestionDialogs>("test.question-dialog");

type EchoPayload = { value: string };
interface Echo {
	echo(payload: EchoPayload, context: Context): Promise<EchoPayload>;
}

const Echo = defineService<Echo>("test.echo");

interface Timeline {
	readonly state: ReplicatedState<{ entries: { id: string }[]; retained: { value: number } }>;
}

const Timeline = defineService<Timeline>("test.timeline");

interface JsonPassthrough {
	call(value: JsonValue, context: Context): Promise<JsonValue>;
}

interface NonJsonArgument {
	call(value: Date, context: Context): Promise<void>;
}

interface NonJsonResult {
	call(context: Context): Promise<bigint>;
}

interface NonJsonState {
	readonly state: ReplicatedState<{ value: undefined }>;
}

describe("remote services", () => {
	test("checks remote JSON contracts only at compile time", () => {
		expect(defineService<JsonPassthrough>("test.json-passthrough").local).toBe(false);
		const defineInvalidContracts = (): void => {
			// @ts-expect-error Remote service arguments must be JSON-compatible.
			defineService<NonJsonArgument>("test.non-json-argument");
			// @ts-expect-error Remote service results must be JSON-compatible.
			defineService<NonJsonResult>("test.non-json-result");
			// @ts-expect-error Replicated state must be JSON-compatible.
			defineService<NonJsonState>("test.non-json-state");
		};
		expect(defineInvalidContracts).not.toThrow();
		expect(defineService<NonJsonArgument>("test.local-non-json", { local: true }).local).toBe(true);
	});

	test("marks services remotable by default and reserves Chord service IDs", () => {
		const local = defineService<{ readonly value: string }>("test.local", { local: true });
		expect(Models.local).toBe(false);
		expect(local.local).toBe(true);
		expect(() => defineService("$chord.internal", { local: true })).toThrow(
			"Service IDs beginning with $chord. are reserved",
		);
		expect(() => new RemoteServiceProvider([local])).toThrow("cannot be published remotely");
	});

	test("tracks mutable source state while publishing immutable revisions", () => {
		const initial: ModelsState = { selected: null, revision: 0 };
		const state = replicatedState(initial);
		let delivered: ModelsState | undefined;
		const deliveries: string[] = [];
		const unsubscribe = state.subscribe((value, _context, delivery) => {
			delivered = value;
			deliveries.push(delivery.kind);
		});
		expect(state.value).toEqual(initial);
		expect(state.value).not.toBe(initial);
		expect(delivered).toBe(state.value);
		const hydrated = delivered;

		state.state.selected = { provider: "test", modelId: "one" };
		state.state.revision = 1;
		state.publish(BACKGROUND_CONTEXT);
		expect(state.value).toEqual({ selected: { provider: "test", modelId: "one" }, revision: 1 });
		expect(state.value).not.toBe(initial);
		expect(delivered).toBe(state.value);
		expect(hydrated).toEqual({ selected: null, revision: 0 });
		expect(deliveries).toEqual(["hydrate", "update"]);
		unsubscribe();
	});

	test("flushes pending mutations before hydrating a new state subscriber", () => {
		const state = replicatedState({ entries: [{ id: "one" }] });
		const first: { entries: { id: string }[] }[] = [];
		state.subscribe((value) => first.push(value));
		state.state.entries.push({ id: "two" });

		const second: { entries: { id: string }[] }[] = [];
		state.subscribe((value) => second.push(value));

		expect(first).toEqual([{ entries: [{ id: "one" }] }, { entries: [{ id: "one" }, { id: "two" }] }]);
		expect(second).toEqual([{ entries: [{ id: "one" }, { id: "two" }] }]);
	});

	test("does not defensively clone method arguments or results", async () => {
		const provider = new RemoteServiceProvider([Echo]);
		let received: EchoPayload | undefined;
		const response: EchoPayload = { value: "response" };
		provider.provide(Echo, {
			async echo(payload) {
				received = payload;
				return response;
			},
		});
		const namespace = createRemoteServiceBinding({
			services: [Echo],
			transport: createLoopbackServiceTransport(provider),
		});
		const echo = namespace.use(Echo);
		await namespace.ready(BACKGROUND_CONTEXT);
		const request: EchoPayload = { value: "request" };

		await expect(echo.echo(request, BACKGROUND_CONTEXT)).resolves.toBe(response);
		expect(received).toBe(request);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("provides and consumes one singleton with replicated state", async () => {
		const provider = new RemoteServiceProvider([Models]);
		expect(provider.catalogue).toEqual([{ serviceId: Models.id, mode: "singleton" }]);
		const initialState: ModelsState = { selected: null, revision: 0 };
		const state = replicatedState(initialState);
		let publishedState: ModelsState | undefined;
		provider.provide(Models, {
			state,
			async select(model, context) {
				state.state.selected = model;
				state.state.revision += 1;
				state.publish(context);
				publishedState = state.value;
			},
		});
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
			onError: (error) => errors.push(error),
		});

		const first = namespace.use(Models);
		const second = namespace.use(Models);
		expect(first).toBe(second);
		expect(first.state.value).toBeUndefined();
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(first.state.value).toEqual(initialState);

		const updates: ModelsState[] = [];
		const unsubscribe = second.state.subscribe((value) => updates.push(value));
		await first.select({ provider: "test", modelId: "one" }, BACKGROUND_CONTEXT);
		expect(first.state.value).toEqual(publishedState);
		expect(first.state.value).toEqual({
			selected: { provider: "test", modelId: "one" },
			revision: 1,
		});
		expect(updates).toEqual([
			{ selected: null, revision: 0 },
			{ selected: { provider: "test", modelId: "one" }, revision: 1 },
		]);
		expect(errors).toEqual([]);

		const lateNamespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
		});
		const lateModels = lateNamespace.use(Models);
		await lateNamespace.ready(BACKGROUND_CONTEXT);
		expect(lateModels.state.value?.revision).toBe(1);

		unsubscribe();
		await Promise.all([namespace.dispose(BACKGROUND_CONTEXT), lateNamespace.dispose(BACKGROUND_CONTEXT)]);
		provider.dispose();
	});

	test("publishes compact tracked operations through the remote provider", async () => {
		const provider = new RemoteServiceProvider([Timeline]);
		const initial = { entries: [{ id: "one" }], retained: { value: 1 } };
		const source = replicatedState(initial);
		provider.provide(Timeline, { state: source });
		const updates: Array<Parameters<Parameters<typeof provider.subscribe>[2]>[0]> = [];
		const raw = provider.subscribe(Timeline.id, "singleton", (update) => updates.push(update));
		expect(raw.snapshot.instances[0]?.members).toEqual([
			{ name: "state", kind: "state", sequence: 0, ops: [["r", initial]] },
		]);
		raw.activate();

		const namespace = createRemoteServiceBinding({
			services: [Timeline],
			transport: createLoopbackServiceTransport(provider),
		});
		const timeline = namespace.use(Timeline);
		await namespace.ready(BACKGROUND_CONTEXT);
		const previous = timeline.state.value;
		const next = { entries: [{ id: "one" }, { id: "two" }], retained: initial.retained };
		source.state.entries.push({ id: "two" });
		source.publish(BACKGROUND_CONTEXT);

		expect(updates).toContainEqual({
			type: "state",
			member: "state",
			sequence: 1,
			ops: [["p", ["entries"], 1, 0, [{ id: "two" }]]],
		});
		expect(previous).toEqual({ entries: [{ id: "one" }], retained: { value: 1 } });
		expect(timeline.state.value).toEqual(next);

		source.state.entries.push({ id: "three" });
		const late = provider.subscribe(Timeline.id, "singleton", () => {});
		expect(updates.at(-1)).toEqual({
			type: "state",
			member: "state",
			sequence: 2,
			ops: [["p", ["entries"], 2, 0, [{ id: "three" }]]],
		});
		expect(late.snapshot.instances[0]?.members).toEqual([
			{
				name: "state",
				kind: "state",
				sequence: 2,
				ops: [["r", { entries: [{ id: "one" }, { id: "two" }, { id: "three" }], retained: { value: 1 } }]],
			},
		]);
		late.close();
		raw.close();
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("keeps singleton facades stable when their provider is replaced", async () => {
		const provider = new RemoteServiceProvider([Models]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 1 }),
			async select() {},
		});
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
		});
		const models = namespace.use(Models);
		const state = models.state;
		const select = models.select;
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(state.value?.revision).toBe(1);

		provider.withdraw(Models);
		expect(state.value).toBeUndefined();
		await expect(select({ provider: "test", modelId: "unavailable" }, BACKGROUND_CONTEXT)).rejects.toMatchObject({
			code: "service_not_found",
		});

		const replacementSelect = vi.fn(async () => {});
		provider.replace(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 2 }),
			select: replacementSelect,
		});

		expect(namespace.use(Models)).toBe(models);
		expect(models.state).toBe(state);
		expect(state.value?.revision).toBe(2);
		await select({ provider: "test", modelId: "replacement" }, BACKGROUND_CONTEXT);
		expect(replacementSelect).toHaveBeenCalledOnce();
		expect(() =>
			provider.replace(Models, {
				async select() {},
			} as unknown as Models),
		).toThrow("replacement must preserve its member shape");
		expect(() =>
			provider.replace(Models, {
				async state() {},
				async select() {},
			} as unknown as Models),
		).toThrow("replacement must preserve its member shape");
		expect(state.value?.revision).toBe(2);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("delivers active subscriber updates before reporting listener failures", () => {
		const failure = new Error("listener failed");
		const provider = new RemoteServiceProvider([Models]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 1 }),
			async select() {},
		});
		let delivered = 0;
		const failing = provider.subscribe(Models.id, "singleton", () => {
			throw failure;
		});
		const succeeding = provider.subscribe(Models.id, "singleton", () => {
			delivered += 1;
		});
		failing.activate();
		succeeding.activate();

		expect(() =>
			provider.replace(Models, {
				state: replicatedState<ModelsState>({ selected: null, revision: 2 }),
				async select() {},
			}),
		).toThrow(failure);
		expect(delivered).toBe(1);

		failing.close();
		succeeding.close();
		provider.dispose();
	});

	test("replays every buffered update before reporting listener failures", () => {
		const failure = new Error("listener failed");
		const provider = new RemoteServiceProvider([Models]);
		const state = replicatedState<ModelsState>({ selected: null, revision: 0 });
		provider.provide(Models, { state, async select() {} });
		let delivered = 0;
		const subscription = provider.subscribe(Models.id, "singleton", () => {
			delivered += 1;
			throw failure;
		});
		state.state.revision = 1;
		state.publish(BACKGROUND_CONTEXT);
		state.state.revision = 2;
		state.publish(BACKGROUND_CONTEXT);

		expect(() => subscription.activate()).toThrow("Failed to activate remote service subscription");
		expect(delivered).toBe(2);
		subscription.close();
		provider.dispose();
	});

	test("clears retained facades when providers and bindings are disposed", async () => {
		const provider = new RemoteServiceProvider([Models]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 1 }),
			async select() {},
		});
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
		});
		const models = namespace.use(Models);
		const state = models.state;
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(state.value?.revision).toBe(1);

		provider.dispose();
		expect(state.value).toBeUndefined();
		await expect(models.select({ provider: "test", modelId: "one" }, BACKGROUND_CONTEXT)).rejects.toThrow(
			"Remote service provider is disposed",
		);

		await namespace.dispose(BACKGROUND_CONTEXT);
		expect(() => state.value).toThrow("Remote service binding is disposed");
	});

	test("applies provider disposal buffered while subscriptions are starting", async () => {
		const provider = new RemoteServiceProvider([Models, { service: QuestionDialogs, mode: "keyed" }]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 1 }),
			async select() {},
		});
		provider.spawn(QuestionDialogs, "pending", {
			request: replicatedState<Question>({ question: "Pending?" }),
			async submit() {
				return { accepted: true };
			},
		});
		const namespace = createRemoteServiceBinding({
			services: [Models, QuestionDialogs],
			transport: createLoopbackServiceTransport(provider),
		});
		const models = namespace.use(Models);
		const observed: QuestionDialogs[] = [];
		namespace.observe(QuestionDialogs, (service) => {
			observed.push(service);
		});

		provider.dispose();
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(models.state.value).toBeUndefined();
		expect(observed).toEqual([]);

		await namespace.dispose(BACKGROUND_CONTEXT);
	});

	test("keeps deferred service handles inaccessible until host activation", async () => {
		const provider = new RemoteServiceProvider([Models]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 0 }),
			async select() {},
		});
		let active = false;
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
			bound: false,
			assertAccess() {
				if (!active) throw new Error("Service handles are not active");
			},
		});
		const models = namespace.use(Models);

		expect(() => models.state.value).toThrow("Service handles are not active");
		expect(() => models.state.subscribe(() => {})).toThrow("Service handles are not active");
		expect(() => models.select({ provider: "test", modelId: "one" }, BACKGROUND_CONTEXT)).toThrow(
			"Service handles are not active",
		);

		await namespace.rebind(true, BACKGROUND_CONTEXT);
		active = true;
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(0);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("rejects namespace readiness when initial hydration fails", async () => {
		const failure = new Error("initial hydration failed");
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: {
				invoke: () => Promise.reject(new Error("unexpected invocation")),
				subscribe: () => Promise.reject(failure),
			},
			onError: (error) => errors.push(error),
		});
		const models = namespace.use(Models);

		await expect(namespace.ready(BACKGROUND_CONTEXT)).rejects.toBe(failure);
		expect(models.state.value).toBeUndefined();
		expect(errors).toEqual([failure]);
		await namespace.dispose(BACKGROUND_CONTEXT);
	});

	test("buffers state updates that race subscription hydration", async () => {
		const provider = new RemoteServiceProvider([Models]);
		const state = replicatedState<ModelsState>({ selected: null, revision: 0 });
		provider.provide(Models, {
			state,
			async select() {},
		});
		const transport: RemoteServiceTransport = {
			invoke: (call, context) => provider.invoke(call, context),
			subscribe: async (serviceId, mode, listener) => {
				const subscription = provider.subscribe(serviceId, mode, listener);
				state.state.revision = 1;
				state.publish(BACKGROUND_CONTEXT);
				return {
					snapshot: subscription.snapshot,
					activate: () => subscription.activate(),
					close: () => subscription.close(),
				};
			},
		};
		const namespace = createRemoteServiceBinding({ services: [Models], transport });
		const models = namespace.use(Models);
		const revisions: number[] = [];
		models.state.subscribe((value) => revisions.push(value.revision));

		await vi.waitFor(() => expect(revisions).toEqual([0, 1]));
		expect(models.state.value?.revision).toBe(1);
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test.each([
		["duplicate", 0],
		["gap", 2],
	] as const)("clears replicated state after a %s operation sequence", async (_kind, sequence) => {
		let sendUpdate: ((update: Parameters<Parameters<RemoteServiceTransport["subscribe"]>[2]>[0]) => void) | undefined;
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: {
				invoke: () => Promise.reject(new Error("unexpected invocation")),
				async subscribe(_serviceId, _mode, listener) {
					sendUpdate = (update) => listener(update, BACKGROUND_CONTEXT);
					return {
						snapshot: {
							serviceId: Models.id,
							mode: "singleton",
							instances: [
								{
									members: [
										{ name: "select", kind: "method" },
										{
											name: "state",
											kind: "state",
											sequence: 0,
											ops: [["r", { selected: null, revision: 0 }]],
										},
									],
								},
							],
						},
						activate() {},
						close() {},
					};
				},
			},
			onError: (error) => errors.push(error),
		});
		const models = namespace.use(Models);
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(0);

		sendUpdate?.({
			type: "state",
			member: "state",
			sequence,
			ops: [["r", { selected: null, revision: sequence }]],
		});
		expect(models.state.value).toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("sequence has a gap");
		await namespace.dispose(BACKGROUND_CONTEXT);
	});

	test("hydrates cold ReplicatedState replicas and replaces them across rebinds", async () => {
		const provider = new RemoteServiceProvider([Models]);
		const state = replicatedState<ModelsState>({ selected: null, revision: 0 });
		provider.provide(Models, {
			state,
			async select() {},
		});
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
			bound: false,
		});
		const models = namespace.use(Models);
		const revisions: number[] = [];
		models.state.subscribe((value) => revisions.push(value.revision));
		expect(models.state.value).toBeUndefined();
		expect(revisions).toEqual([]);

		state.state.revision = 1;
		state.publish(BACKGROUND_CONTEXT);
		await namespace.rebind(true, BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(1);
		expect(revisions).toEqual([1]);
		state.state.revision = 2;
		state.publish(BACKGROUND_CONTEXT);
		expect(revisions).toEqual([1, 2]);

		await namespace.rebind(false, BACKGROUND_CONTEXT);
		expect(models.state.value).toBeUndefined();
		state.state.revision = 3;
		state.publish(BACKGROUND_CONTEXT);
		expect(revisions).toEqual([1, 2]);
		await namespace.rebind(true, BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(3);
		expect(revisions).toEqual([1, 2, 3]);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("hydrates keyed state before observe handlers and fences reused keys", async () => {
		const provider = new RemoteServiceProvider([{ service: QuestionDialogs, mode: "keyed" }]);
		expect(provider.catalogue).toEqual([{ serviceId: QuestionDialogs.id, mode: "keyed" }]);
		const transport = createLoopbackServiceTransport(provider);
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [QuestionDialogs],
			transport,
			onError: (error) => errors.push(error),
		});
		const observed: {
			question: Question | undefined;
			service: QuestionDialogs;
			context: Context;
		}[] = [];
		const stop = namespace.observe(QuestionDialogs, (service, context) => {
			observed.push({
				question: service.request.value,
				service,
				context,
			});
		});
		await vi.waitFor(() => expect(errors).toEqual([]));

		const firstRequest = replicatedState<Question>({ question: "First?" });
		const firstSubmit = vi.fn(async () => ({ accepted: true }));
		const closeFirst = provider.spawn(QuestionDialogs, "invocation-1", {
			request: firstRequest,
			submit: firstSubmit,
		});
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		expect(observed[0]).toMatchObject({ question: { question: "First?" } });

		const firstService = observed[0]!.service;
		firstRequest.state.question = "Updated?";
		firstRequest.publish(BACKGROUND_CONTEXT);
		expect(firstService.request.value).toEqual({ question: "Updated?" });
		await expect(firstService.submit("yes", BACKGROUND_CONTEXT)).resolves.toEqual({ accepted: true });
		expect(firstSubmit).toHaveBeenCalledWith("yes", expect.objectContaining({ abortSignal: undefined }));

		const retainedFirstSubmit = firstService.submit;
		closeFirst();
		expect(observed[0]!.context.abortSignal?.aborted).toBe(true);
		expect(() => firstService.request.value).toThrow("observation is closed");
		expect(() => retainedFirstSubmit("late", BACKGROUND_CONTEXT)).toThrow("observation is closed");

		const secondRequest = replicatedState<Question>({ question: "Again?" });
		const closeSecond = provider.spawn(QuestionDialogs, "invocation-1", {
			request: secondRequest,
			async submit() {
				return { accepted: false };
			},
		});
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		expect(observed[1]).toMatchObject({ question: { question: "Again?" } });
		expect(Object.is(observed[1]!.service, firstService)).toBe(false);
		expect(errors).toEqual([]);

		const secondService = observed[1]!.service;
		const retainedSecondSubmit = secondService.submit;
		stop();
		expect(observed[1]!.context.abortSignal?.aborted).toBe(true);
		expect(() => secondService.request.value).toThrow("observation is closed");
		expect(() => retainedSecondSubmit("late", BACKGROUND_CONTEXT)).toThrow("observation is closed");
		closeSecond();
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("rejects mode mixing and unsupported members", () => {
		const provider = new RemoteServiceProvider([Models, { service: QuestionDialogs, mode: "keyed" }]);
		provider.provide(Models, {
			state: replicatedState<ModelsState>({ selected: null, revision: 0 }),
			async select() {},
		});
		expect(() => provider.spawn(Models, "wrong", {} as Models)).toThrow(/singleton/);
		expect(() =>
			provider.spawn(QuestionDialogs, "invalid", {
				request: new Date() as unknown as ReplicatedState<Question>,
				async submit() {
					return { accepted: true };
				},
			}),
		).toThrow(/not remotely exposable/);
		provider.dispose();
	});
});
