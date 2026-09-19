import assert from "node:assert/strict";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { applyEnvelope, kinds } from "../../../src/harness/pico3/harness.ts";
import { JsonlStorage } from "../../../src/harness/pico3/jsonl.ts";
import {
	defineTask,
	Forbidden,
	type JsonObject,
	type JsonValue,
	type KindConfig,
	memoOnce,
	type Namespace,
	type ToolApi,
	type ToolDeclaration,
} from "../../../src/harness/pico3/types.ts";
import { contentOf, ctx, Gate, model, open } from "./helpers.ts";

type MemoToolApi = ToolApi & {
	memo<T extends JsonValue>(name: string, candidate: T, context: typeof ctx): Promise<T>;
	memo<T extends JsonValue>(name: string, context: typeof ctx): Promise<T | undefined>;
};

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type WaitingApi = {
	waiting(context: typeof ctx): Promise<void>;
	memo<T extends JsonValue>(name: string, candidate: T, context: typeof ctx): Promise<T>;
	emit(name: string, data: JsonValue, context: typeof ctx): Promise<void>;
};

test("namespace defaults route to their declared documents, preserve null, and seed lazily", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const ns = env.h.namespace<{
		plan: { enabled: boolean };
		cache: string | null;
		global: { count: number };
	}>("spec.routing", {
		rewindable: { plan: { enabled: false } },
		sticky: { cache: null },
		session: { global: { count: 0 } },
	});
	const first = await env.root.commit((tx) => {
		const slice = tx.plugins(ns);
		assert.equal(slice.cache, null);
		slice.plan.enabled = true;
		slice.global.count++;
		return cloneJson(slice);
	}, ctx);
	assert.deepEqual(first, { plan: { enabled: true }, cache: null, global: { count: 1 } });
	assert.deepEqual((await env.root.rewindable(ctx)).plugins[ns.id], { plan: { enabled: true } });
	assert.deepEqual((await env.root.sticky(ctx)).plugins[ns.id], { cache: null });
	const sessionSlice = await env.root.commit((tx) => cloneJson(tx.plugins(ns).global), ctx);
	assert.deepEqual(sessionSlice, { count: 1 });
});

test("namespace token identity is current authority; unregister is idempotent; re-register retains state and adds defaults", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const old = env.h.namespace<{ value: number }>("spec.reload", { rewindable: { value: 1 } });
	await env.root.commit((tx) => {
		tx.plugins(old).value = 7;
	}, ctx);
	old.unregister();
	old.unregister();
	await assert.rejects(
		env.root.commit((tx) => tx.plugins(old), ctx),
		Forbidden,
	);

	const current = env.h.namespace<{ value: number; added: string }>("spec.reload", {
		rewindable: { value: 100, added: "new-default" },
	});
	assert.deepEqual(await env.root.commit((tx) => cloneJson(tx.plugins(current)), ctx), {
		value: 7,
		added: "new-default",
	});
	old.unregister();
	await env.root.commit((tx) => {
		tx.plugins(current).added = "still-current";
	}, ctx);
	assert.equal(await env.root.commit((tx) => tx.plugins(current).added, ctx), "still-current");
});

test("namespace declarations reject ambiguous routing, reserved names, duplicate live registrations, and stale emits", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	assert.throws(() => env.h.namespace("pi.private", {}), /invalid namespace/);
	assert.throws(() => env.h.namespace("bad space", {}), /invalid namespace/);
	assert.throws(
		() =>
			env.h.namespace<{ duplicate: number }>("spec.ambiguous", {
				rewindable: { duplicate: 1 },
				sticky: { duplicate: 2 },
			}),
		/more than one document/,
	);
	const token = env.h.namespace<{ value: number }>("spec.unique", { sticky: { value: 0 } });
	assert.throws(() => env.h.namespace("spec.unique", {}), /already registered/);
	token.unregister();
	await assert.rejects(
		env.root.commit((tx) => tx.emit(token, "late", { value: true }), ctx),
		Forbidden,
	);
});

test("namespace view projection is the only public plugin state and emit produces a namespaced event in the same envelope", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const ns = env.h.namespace<{ visible: number; secret: string }>(
		"spec.presentation",
		{ rewindable: { visible: 0 }, sticky: { secret: "hidden" } },
		{ view: (slice) => ({ visible: slice.visible }) },
	);
	const watch = await env.root.watch(ctx);
	const deliveries: Array<{ events?: { type: string; data?: JsonValue }[]; view: object }> = [];
	let folded = watch.view;
	watch.start((envelope) => {
		folded = applyEnvelope(folded, envelope);
		deliveries.push({
			events: (envelope as unknown as { events?: { type: string; data?: JsonValue }[] }).events,
			view: folded,
		});
	});
	await env.root.commit((tx) => {
		const slice = tx.plugins(ns);
		slice.visible = 2;
		slice.secret = "do-not-project";
		tx.emit(ns, "changed", { visible: 2 });
	}, ctx);
	assert.equal(deliveries.length, 1);
	const flat = folded as unknown as { plugins: Record<string, JsonValue> };
	assert.deepEqual(flat.plugins[ns.id], { visible: 2 });
	assert.doesNotMatch(JSON.stringify(flat.plugins), /do-not-project/);
	assert.deepEqual(deliveries[0]!.events, [{ type: "plugin.spec.presentation.changed", data: { visible: 2 } }]);
	watch.stop();
});

test("memoOnce is first-writer-wins for null and isolates equal names in different slots", () => {
	const first: JsonObject = {};
	const second: JsonObject = {};
	assert.equal(memoOnce(first, "decision", null), null);
	assert.equal(memoOnce(first, "decision", "later"), null);
	assert.equal(memoOnce(second, "decision", "other-task"), "other-task");
	assert.deepEqual(first, { memos: { decision: null } });
	assert.deepEqual(second, { memos: { decision: "other-task" } });
});

test("ToolApi.memo serializes concurrent writers, returns the durable winner, and isolates later tool tasks", async () => {
	const schema = Type.Object({ v: Type.String() });
	const winners: JsonValue[][] = [];
	const declaration: ToolDeclaration<typeof schema> = {
		name: "memo-tool",
		description: "",
		parameters: schema,
		replay: "safe",
		async execute(_args, rawApi, context) {
			const api = rawApi as MemoToolApi;
			const pair = await Promise.all([api.memo("winner", "first", context), api.memo("winner", "second", context)]);
			winners.push(pair);
			const stored = await api.memo<JsonValue>("winner", context);
			return { content: [{ type: "text", text: JSON.stringify({ pair, stored }) }] };
		},
	};
	const env = await open({ tools: [declaration], root: { rewindable: { model, selectedTools: [declaration.name] } } });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "tool:memo-tool" }, ctx)).wait(ctx);
	await (await env.root.send({ content: "tool:memo-tool" }, ctx)).wait(ctx);
	assert.deepEqual(winners, [
		["first", "first"],
		["first", "first"],
	]);
	const toolTasks = (await env.tasks()).filter((task) => task.kind === "pi.tool");
	assert.equal(toolTasks.length, 2);
	const sticky = await env.root.sticky(ctx);
	for (const task of toolTasks) assert.equal(sticky.tasks[task.id], undefined, "terminal slot and memos retired");
});

test("a safe tool memo survives recovery and prevents repeating the coordinated external decision", async () => {
	const gate = new Gate();
	let asks = 0;
	let missingApi = false;
	const makeTool = (block: boolean): ToolDeclaration => ({
		name: "recover-memo",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		replay: "safe",
		async execute(_args, rawApi, context) {
			const api = rawApi as Partial<MemoToolApi>;
			if (typeof api.memo !== "function") {
				missingApi = true;
				asks++;
				if (block) await gate.wait(context);
				return { content: [{ type: "text", text: "memo unavailable" }] };
			}
			let decision = await api.memo<string>("decision", context);
			if (decision === undefined) {
				asks++;
				decision = await api.memo("decision", "approved", context);
				if (block) await gate.wait(context);
			}
			return { content: [{ type: "text", text: decision }] };
		},
	});
	let env = await open({ backend: "jsonl", tools: [makeTool(true)] });
	onTestFinished(() => env.close());
	await env.root.send({ content: "tool:recover-memo" }, ctx);
	await gate.arrivals(1);
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl", tools: [makeTool(false)] });
	await env.root.waitForIdle(ctx);
	assert.equal(missingApi, false);
	assert.equal(asks, 1, "recovery reads the first invocation's durable memo instead of asking again");
	const result = (await env.entries()).find((entry) => entry.kind === "pi.tool_result")!;
	assert.match(contentOf(result), /approved/);
});

test("beforeTool waiting/memo/emit are namespace-bound and waitingOn clears atomically with started", async () => {
	const toolGate = new Gate();
	const declaration: ToolDeclaration = {
		name: "approved-tool",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		replay: "safe",
		async execute(_args, _api, context) {
			await toolGate.wait(context);
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	const env = await open({ tools: [declaration] });
	onTestFinished(() => env.close());
	const ns = env.h.namespace<{ approvals: number }>("spec.approval", { sticky: { approvals: 0 } });
	const harnessWithNamespacedHooks = env.h as unknown as {
		hooks<T extends JsonObject>(
			namespace: Namespace<T>,
			kind: typeof kinds.tool,
			handlers: { beforeTool(call: unknown, api: WaitingApi, context: typeof ctx): Promise<void> },
		): () => void;
	};
	let releaseApproval!: () => void;
	const approval = new Promise<void>((resolve) => {
		releaseApproval = resolve;
	});
	const off = harnessWithNamespacedHooks.hooks(ns, kinds.tool, {
		async beforeTool(_call, api, context) {
			await api.waiting(context);
			await approval;
			await api.memo("decision", "allow", context);
			await api.emit("approved", { by: "spec" }, context);
		},
	});
	const input = await env.root.send({ content: "tool:approved-tool" }, ctx);
	for (let i = 0; i < 100; i++) {
		const waiting = (await env.root.sticky(ctx)).turn.tools[0]?.waitingOn;
		if (waiting === ns.id) break;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.equal((await env.root.sticky(ctx)).turn.tools[0]?.waitingOn, ns.id);
	releaseApproval();
	await toolGate.arrivals(1);
	const slot = (await env.root.sticky(ctx)).turn.tools[0]!;
	assert.equal(slot.status, "running");
	assert.equal(slot.waitingOn, undefined);
	toolGate.open();
	await input.wait(ctx);
	off();
});

test("a throwing beforeTool handler clears waitingOn in the same synthetic-result envelope", async () => {
	let toolCalls = 0;
	const declaration: ToolDeclaration = {
		name: "blocked-after-wait",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute() {
			toolCalls++;
			return { content: [{ type: "text", text: "must not run" }] };
		},
	};
	const env = await open({ tools: [declaration] });
	onTestFinished(() => env.close());
	const ns = env.h.namespace("spec.throwing-approval", {});
	const namespaced = env.h as unknown as {
		hooks<T extends JsonObject>(
			namespace: Namespace<T>,
			kind: typeof kinds.tool,
			handlers: { beforeTool(call: unknown, api: WaitingApi, context: typeof ctx): Promise<void> },
		): () => void;
	};
	const off = namespaced.hooks(ns, kinds.tool, {
		async beforeTool(_call, api, context) {
			await api.waiting(context);
			throw new Error("approval service failed");
		},
	});
	const watch = await env.root.watch(ctx);
	const envelopes: Array<{ ops: unknown[]; events: Array<{ type: string }> }> = [];
	watch.start((envelope) =>
		envelopes.push(envelope as unknown as { ops: unknown[]; events: Array<{ type: string }> }),
	);
	await (await env.root.send({ content: "tool:blocked-after-wait" }, ctx)).wait(ctx);
	assert.equal(toolCalls, 0);
	const result = (await env.entries()).find((entry) => entry.kind === "pi.tool_result")!;
	assert.match(contentOf(result), /hook threw: Error: approval service failed/);
	const finish = envelopes.find((envelope) => envelope.events.some((event) => event.type === "tool.finished"));
	assert.ok(finish);
	assert.match(JSON.stringify(finish.ops), /waitingOn/);
	assert.equal((await env.root.sticky(ctx)).turn.tools.length, 0);
	watch.stop();
	off();
});

test("abort unwinds a waiting beforeTool handler and does not leave waitingOn durable", async () => {
	const waitingGate = new Gate();
	const declaration: ToolDeclaration = {
		name: "wait-forever",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute() {
			return { content: [] };
		},
	};
	const env = await open({ tools: [declaration] });
	onTestFinished(() => env.close());
	const ns = env.h.namespace("spec.abort-approval", {});
	const namespaced = env.h as unknown as {
		hooks<T extends JsonObject>(
			namespace: Namespace<T>,
			kind: typeof kinds.tool,
			handlers: { beforeTool(call: unknown, api: WaitingApi, context: typeof ctx): Promise<void> },
		): () => void;
	};
	namespaced.hooks(ns, kinds.tool, {
		async beforeTool(_call, api, context) {
			await api.waiting(context);
			await waitingGate.wait(context);
		},
	});
	const input = await env.root.send({ content: "tool:wait-forever" }, ctx);
	for (let i = 0; i < 100; i++) {
		if ((await env.root.sticky(ctx)).turn.tools[0]?.waitingOn === ns.id) break;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.equal((await env.root.sticky(ctx)).turn.tools[0]?.waitingOn, ns.id);
	await env.root.abort(ctx);
	assert.equal((await input.result(ctx))?.reason, "aborted");
	assert.deepEqual((await env.root.sticky(ctx)).turn, { tools: [] });
});

test("suspend clears a waiting hook without terminalizing its durable tool task", async () => {
	const gate = new Gate();
	const declaration: ToolDeclaration = {
		name: "suspended-approval",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute() {
			return { content: [] };
		},
	};
	const env = await open({ backend: "jsonl", tools: [declaration] });
	onTestFinished(() => env.close());
	const ns = env.h.namespace("spec.suspended-approval", {});
	env.h.hooks(ns, kinds.tool, {
		async beforeTool(_call, api, context) {
			await api.waiting(context);
			await gate.wait(context);
		},
	});
	await env.root.send({ content: "tool:suspended-approval" }, ctx);
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await env.root.sticky(ctx)).turn.tools[0]?.waitingOn === ns.id) break;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	const task = (await env.tasks()).find((candidate) => candidate.kind === "pi.tool")!;
	await env.h.suspend(ctx);
	const storage = await JsonlStorage.open(env.dir!, { fsync: false });
	try {
		const sticky = await storage.doc({ doc: "sticky", conversationId: 1 }, ctx);
		const tools = (sticky as { turn: { tools: Array<{ waitingOn?: string }> } }).turn.tools;
		assert.equal(tools[0]?.waitingOn, undefined);
		assert.equal((await storage.task(task.id, ctx))?.status, "running");
	} finally {
		await storage.close(ctx);
	}
});

test("equal hook memo names are isolated by namespace on one hosting tool task", async () => {
	const observed: Record<string, JsonValue | undefined> = {};
	const declaration: ToolDeclaration = {
		name: "two-approvals",
		description: "",
		parameters: Type.Object({ v: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	const env = await open({ tools: [declaration] });
	onTestFinished(() => env.close());
	const namespaced = env.h as unknown as {
		hooks<T extends JsonObject>(
			namespace: Namespace<T>,
			kind: typeof kinds.tool,
			handlers: { beforeTool(call: unknown, api: WaitingApi, context: typeof ctx): Promise<void> },
		): () => void;
	};
	for (const id of ["spec.approver-a", "spec.approver-b"] as const) {
		const ns = env.h.namespace(id, {});
		namespaced.hooks(ns, kinds.tool, {
			async beforeTool(_call, api, context) {
				await api.memo("decision", id, context);
				observed[id] = await (api as unknown as MemoToolApi).memo<JsonValue>("decision", context);
			},
		});
	}
	await (await env.root.send({ content: "tool:two-approvals" }, ctx)).wait(ctx);
	assert.deepEqual(observed, {
		"spec.approver-a": "spec.approver-a",
		"spec.approver-b": "spec.approver-b",
	});
});

test("custom task describe cannot project private slot memos", async () => {
	const gate = new Gate();
	type Slot = { progress: number; memos?: { secret: string } };
	const kind = defineTask<null, { phase: "never" }, null, null, null, object, KindConfig, Slot>({
		name: "spec.private-memo-view",
		slot: () => ({ progress: 0 }),
		describe: (task) => task.slot ?? null,
		async initial(task, runtime, context) {
			await runtime.commit((tx) => {
				const slot = tx.slot({ id: task.id, kind });
				slot.progress = 1;
				slot.memos = { secret: "never-project" };
			}, context);
			await gate.wait(context);
			return { done: () => ({ status: "completed", result: null }) };
		},
		phases: {
			async never() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [kind] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(kind, null, { conversationId: 1, background: true }), ctx);
	await gate.arrivals(1);
	const watch = await env.root.watch(ctx);
	assert.deepEqual(watch.view.tasks[ref.id]?.status, { progress: 1 });
	assert.doesNotMatch(JSON.stringify(watch.view), /never-project/);
	watch.stop();
	gate.open();
	await env.h.waitForTask(ref.id, ctx);
});

test("runtime task-kind registration seeds defaults into already-loaded documents before the task reads them", async () => {
	let observed: unknown;
	const env = await open({});
	onTestFinished(() => env.close());
	await env.root.rewindable(ctx);
	const kind = defineTask<null, { phase: "done" }, null, null, null, object, { rewindable: { enabled: boolean } }>({
		name: "spec.runtime-default",
		config: { rewindable: { enabled: false } },
		async initial(_task, runtime, context) {
			observed = await runtime.commit(
				(tx, current) => ({
					facade: tx.config(current.conversationId).get("enabled"),
					document: tx.snapshot({ doc: "rewindable", conversationId: current.conversationId }).enabled,
				}),
				context,
			);
			return { next: { phase: "done" } };
		},
		phases: {
			async done() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	env.h.registerTaskKind(kind);
	const ref = await env.root.commit(
		(tx) => tx.createTask(kind, null, { conversationId: env.root.id, background: true }),
		ctx,
	);
	await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(observed, { facade: false, document: false });
});

test("an already-running kind keeps its captured config authority after unregister", async () => {
	const gate = new Gate();
	const kind = defineTask<null, { phase: "never" }, string, null, null, object, { sticky: { leaseValue: string } }>({
		name: "spec.active-reload",
		config: { sticky: { leaseValue: "old-default" } },
		async initial(task, runtime, context) {
			await gate.wait(context);
			const value = await runtime.commit((tx) => tx.config(task.conversationId).get("leaseValue"), context);
			return { done: () => ({ status: "completed", result: String(value) }) };
		},
		phases: {
			async never() {
				return { done: () => ({ status: "completed", result: "never" }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({});
	onTestFinished(() => env.close());
	const unregister = env.h.registerTaskKind(kind);
	const ref = await env.root.commit((tx) => tx.createTask(kind, null, { conversationId: 1, background: true }), ctx);
	await gate.arrivals(1);
	unregister();
	gate.open();
	assert.deepEqual((await env.h.waitForTask(ref.id, ctx)).outcome, {
		status: "completed",
		result: "old-default",
	});
});

test("an unregistered kind leaves dependency-blocked tasks pending until a replacement is registered", async () => {
	const gate = new Gate();
	const blocker = defineTask<null, { phase: "never" }, null, null, null>({
		name: "spec.reload-blocker",
		async initial(_task, _runtime, context) {
			await gate.wait(context);
			return { done: () => ({ status: "completed", result: null }) };
		},
		phases: {
			async never() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const makeKind = (result: string) =>
		defineTask<null, { phase: "never" }, string, null, null>({
			name: "spec.pending-reload",
			async initial() {
				return { done: () => ({ status: "completed", result }) };
			},
			phases: {
				async never() {
					return { done: () => ({ status: "completed", result }) };
				},
			},
			async abort() {
				return () => null;
			},
		});
	const original = makeKind("original");
	const env = await open({ taskKinds: [blocker] });
	onTestFinished(() => env.close());
	const removeOriginal = env.h.registerTaskKind(original);
	const refs = await env.root.commit((tx) => {
		const dependency = tx.createTask(blocker, null, { conversationId: 1, background: true });
		const target = tx.createTask(original, null, {
			conversationId: 1,
			background: true,
			after: [dependency.id],
		});
		return { dependency, target };
	}, ctx);
	await gate.arrivals(1);
	removeOriginal();
	gate.open();
	await env.h.waitForTask(refs.dependency.id, ctx);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal((await env.h.getTask(refs.target.id, ctx))?.status, "pending");
	const replacement = makeKind("replacement");
	env.h.registerTaskKind(replacement);
	assert.deepEqual((await env.h.waitForTask(refs.target.id, ctx)).outcome, {
		status: "completed",
		result: "replacement",
	});
});

test("task kind unregister/re-register makes old tokens stale without letting an old unsubscribe remove the replacement", async () => {
	const calls: string[] = [];
	const make = (label: string) =>
		defineTask<null, { phase: "done" }, string, null, null>({
			name: "spec.reload-kind",
			async initial() {
				calls.push(label);
				return { next: { phase: "done" } };
			},
			phases: {
				async done() {
					return { done: () => ({ status: "completed", result: label }) };
				},
			},
			async abort() {
				return () => null;
			},
		});
	const env = await open({});
	onTestFinished(() => env.close());
	const old = make("old");
	const unregisterOld = env.h.registerTaskKind(old);
	unregisterOld();
	unregisterOld();
	const replacement = make("replacement");
	env.h.registerTaskKind(replacement);
	unregisterOld();
	await assert.rejects(
		env.root.commit((tx) => tx.createTask(old, null, { conversationId: 1 }), ctx),
		Forbidden,
	);
	const ref = await env.root.commit(
		(tx) => tx.createTask(replacement, null, { conversationId: 1, background: true }),
		ctx,
	);
	const terminal = await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(terminal.outcome, { status: "completed", result: "replacement" });
	assert.deepEqual(calls, ["replacement"]);
});
