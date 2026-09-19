import assert from "node:assert/strict";
import { Type } from "typebox";
import { onTestFinished, test } from "vitest";
import { Harness, kinds } from "../../../src/harness/pico3/harness.ts";
import { MemoryStorage } from "../../../src/harness/pico3/memory.ts";
import { defineSystemSection } from "../../../src/harness/pico3/system.ts";
import {
	type CoreTx,
	defineEntry,
	defineTask,
	Forbidden,
	type Id,
	type Namespace,
	type RequestMessage,
	type Runtime,
	type ToolDeclaration,
} from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, Gate, open, resultOf, tool } from "./helpers.ts";

// ---------------------------------------------------------------------------
// §1 registry and token identity
// ---------------------------------------------------------------------------

test("registry: a plugin kind named pi.* is rejected by defineTask and by open; a duplicate name is rejected; a forged core flag confers nothing", async () => {
	assert.throws(
		() =>
			defineTask({
				name: "pi.generation",
				phases: {},
				async initial() {
					return { done: () => ({ status: "completed", result: null }) };
				},
				async abort() {
					return () => null;
				},
			} as never),
		/reserved/,
	);
	// bypass defineTask entirely
	const forged = { ...kinds.job, name: "pi.generation", core: true };
	await assert.rejects(
		Harness.open(new MemoryStorage(), { models: fake({ respond: echoScript }), taskKinds: [forged as never] }, ctx),
		/reserved/,
	);
	const dup = defineTask<null, { phase: "x" }, null, null, null>({
		name: "dup",
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async initial() {
			return { next: { phase: "x" } };
		},
		async abort() {
			return () => null;
		},
	});
	await assert.rejects(
		Harness.open(new MemoryStorage(), { models: fake({ respond: echoScript }), taskKinds: [dup, { ...dup }] }, ctx),
		/registered twice/,
	);
	// `core: true` on an ordinary kind: still cannot append entries
	let forbidden: unknown;
	const sneaky = {
		...defineTask<null, { phase: "x" }, null, null, null>({
			name: "sneaky",
			phases: {
				async x() {
					return { done: () => ({ status: "completed", result: null }) };
				},
			},
			async initial(_t, rt, c) {
				try {
					await rt.commit((tx) => (tx as CoreTx).appendEntry(1, { kind: "x" }), c);
				} catch (e) {
					forbidden = e;
				}
				return { next: { phase: "x" } };
			},
			async abort() {
				return () => null;
			},
		}),
		core: true,
	};
	const env = await open({ taskKinds: [sneaky] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(sneaky, null, { conversationId: 1, background: true }), ctx);
	await env.h.waitForTask(ref.id, ctx);
	assert.ok(forbidden instanceof Forbidden);
});

test("registry: stale/redeclared kind tokens reject for createTask and hooks; unsubscribe is idempotent and never removes a newer registration", async () => {
	const k = defineTask<null, { phase: "x" }, null, null, null>({
		name: "k",
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async initial() {
			return { next: { phase: "x" } };
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [k], tools: [tool("x")] });
	onTestFinished(() => env.close());
	const hookNamespace = env.h.namespace("test.authority-hooks", {});
	const stale = { ...k }; // same name, different object
	await assert.rejects(
		env.root.commit((tx) => tx.createTask(stale, null, { conversationId: 1 }), ctx),
		/not the registered token/,
	);
	assert.throws(() => env.h.hooks(hookNamespace, stale, {}), /not the registered token/);
	assert.throws(() => env.root.hooks(hookNamespace, { ...kinds.tool }, {}), /not the registered token/);
	const seen: string[] = [];
	const off1 = env.h.hooks(hookNamespace, kinds.tool, {
		beforeTool: (c) => {
			seen.push(`1:${c.name}`);
		},
	});
	off1();
	const off2 = env.h.hooks(hookNamespace, kinds.tool, {
		beforeTool: (c) => {
			seen.push(`2:${c.name}`);
		},
	});
	off1(); // second call: must not splice off2
	await (await env.root.send({ content: "tool:x" }, ctx)).wait(ctx);
	assert.deepEqual(seen, ["2:x"]);
	off2();
	off2();
});

test("registry: duplicate tool/section/entry names reject; unregister removes only the exact object registered", async () => {
	const env = await open({ tools: [tool("x")] });
	onTestFinished(() => env.close());
	assert.throws(() => env.h.registerTool(tool("x")), /already registered/);
	const y1 = tool("y");
	const off = env.h.registerTool(y1);
	off();
	const y2 = tool("y");
	env.h.registerTool(y2);
	off(); // idempotent: y2 stays
	assert.throws(() => env.h.registerTool(tool("y")), /already registered/);
	const s = defineSystemSection<string>({ key: "s", render: (v) => v });
	const offS = env.h.registerSection(s);
	assert.throws(
		() => env.h.registerSection(defineSystemSection<string>({ key: "s", render: (v) => v })),
		/already registered/,
	);
	offS();
	offS();
	const e = defineEntry("e");
	env.h.registerEntryKind(e);
	assert.throws(() => env.h.registerEntryKind(defineEntry("e")), /already registered/);
	assert.throws(() => env.h.registerEntryKind(defineEntry("pi.mine")), /reserved/);
});

test("one owning Session per Storage object in-process", async () => {
	const storage = new MemoryStorage();
	const h = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => h.close(ctx));
	await assert.rejects(
		Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx),
		/already has an owning Session/,
	);
	await h.close(ctx);
	const h2 = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx); // released on close
	await h2.close(ctx);
});

// ---------------------------------------------------------------------------
// §2 capability enforcement with malicious casts from an ordinary task
// ---------------------------------------------------------------------------

/** Runs `attempt` inside an ordinary task's commit with the tx cast to CoreTx; records what it threw. */
function probeKind(
	name: string,
	attempts: { [label: string]: (tx: CoreTx, rt: Runtime, cur: { conversationId: Id; id: Id }) => unknown },
	results: Map<string, unknown>,
) {
	return defineTask<{ target?: Id }, { phase: "x" }, null, null, null>({
		name,
		async initial(_t, rt, c) {
			for (const [label, fn] of Object.entries(attempts)) {
				try {
					await rt.commit(async (tx, cur) => {
						await fn(tx as unknown as CoreTx, rt, cur);
					}, c);
					results.set(label, "allowed");
				} catch (e) {
					results.set(label, e);
				}
			}
			return { next: { phase: "x" } };
		},
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
}

test("malicious casts: every core-only operation rejects at runtime for an ordinary task", async () => {
	const results = new Map<string, unknown>();
	const gate = new Gate();
	let plugin!: Namespace<{ ok: boolean }>;
	let stalePlugin!: Namespace<{ ok: boolean }>;
	const other = defineTask<null, { phase: "x" }, null, null, null>({
		name: "other",
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async initial(_t, _rt, c) {
			await gate.wait(c);
			return { next: { phase: "x" } };
		},
		async abort() {
			return () => null;
		},
	});
	const probe = probeKind(
		"probe",
		{
			send: (tx) => tx.send(1, { content: "x" }),
			boundary: (tx) => tx.boundary(1, "final", undefined),
			resolveInputs: (tx) => tx.resolveInputs([1], { status: "done", answer: 1 }),
			rewindable: (tx) => tx.rewindable(1),
			sticky: (tx) => tx.sticky(1),
			session: (tx) => tx.session(),
			toolSlot: (tx) => tx.toolSlot({ conversationId: 1, input: { index: 0 } }),
			appendEntry: (tx) => tx.appendEntry(1, { kind: "x" }),
			createCoreByName: (tx) => tx.createTask({ kind: "pi.generation", conversationId: 1, input: { inputs: [] } }),
			createCoreByToken: (tx) => tx.createTask(kinds.generation, { inputs: [] }, { conversationId: 1 }),
			markTask: (tx) => tx.markTask(1),
			writeHead: (tx) => tx.write(1, { kind: "x", head: "self" }),
			writeReservedKind: (tx) => tx.write(1, { kind: "pi.assistant", model: [] }),
			otherSlot: (tx) => {
				const t = tx as unknown as { liveTasks: Map<Id, { id: Id; kind: string }> };
				void t;
				return tx.slot({ id: otherId, kind: other });
			},
			outOfSubtreeWrite: (tx) => tx.write(foreignConv, { kind: "x" }),
			outOfSubtreeRead: (tx) => tx.newestEntry(foreignConv),
			outOfSubtreeParent: (tx) => tx.createConversation({ parent: { conversationId: foreignConv, at: "start" } }),
			outOfSubtreeConfig: (tx) => tx.config(foreignConv).get("profile"),
			coreConfigWrite: (tx) =>
				(tx.config(1) as unknown as { set(key: string, value: string): void }).set("profile", "forged"),
			stalePlugin: (tx) => tx.plugins(stalePlugin),
			ownWriteAllowed: (tx) => tx.write(1, { kind: "x" }),
			ownPluginAllowed: (tx) => {
				tx.plugins(plugin).ok = true;
			},
		},
		results,
	);
	let otherId = 0;
	let foreignConv = 0;
	const env = await open({ taskKinds: [probe, other] });
	onTestFinished(() => env.close());
	stalePlugin = env.h.namespace("test.task-plugin", { sticky: { ok: false } });
	stalePlugin.unregister();
	plugin = env.h.namespace("test.task-plugin", { sticky: { ok: false } });
	foreignConv = (await env.h.createConversation({}, ctx)).id;
	otherId = (await env.root.commit((tx) => tx.createTask(other, null, { conversationId: 1, background: true }), ctx))
		.id;
	await gate.arrivals(1);
	const ref = await env.root.commit((tx) => tx.createTask(probe, {}, { conversationId: 1, background: true }), ctx);
	await env.h.waitForTask(ref.id, ctx);
	gate.open();
	const forbidden = [...results.entries()]
		.filter(([, v]) => v instanceof Forbidden)
		.map(([k]) => k)
		.sort();
	const allowed = [...results.entries()]
		.filter(([, v]) => v === "allowed")
		.map(([k]) => k)
		.sort();
	assert.deepEqual(allowed, ["ownPluginAllowed", "ownWriteAllowed"]);
	assert.deepEqual(forbidden, [
		"appendEntry",
		"boundary",
		"coreConfigWrite",
		"createCoreByName",
		"createCoreByToken",
		"markTask",
		"otherSlot",
		"outOfSubtreeConfig",
		"outOfSubtreeParent",
		"outOfSubtreeRead",
		"outOfSubtreeWrite",
		"resolveInputs",
		"rewindable",
		"send",
		"session",
		"stalePlugin",
		"sticky",
		"toolSlot",
		"writeHead",
		"writeReservedKind",
	]);
	assert.equal(
		results.size,
		forbidden.length + allowed.length,
		`unexpected outcomes: ${[...results.entries()]
			.filter(([, v]) => v !== "allowed" && !(v instanceof Forbidden))
			.map(([k, v]) => `${k}=${String(v)}`)
			.join(", ")}`,
	);
});

test("host tx: core operations reject via cast; host write/plugin state/config work", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ s: number }>("test.host-session", { session: { s: 0 } });
	let escaped: CoreTx | undefined;
	let escapedConfig: ReturnType<CoreTx["config"]> | undefined;
	let callbackArguments = 0;
	await env.root.commit((tx, ...args) => {
		callbackArguments = 1 + args.length;
		escaped = tx as unknown as CoreTx;
		escapedConfig = tx.config(1);
		const cast = tx as unknown as Record<string, unknown>;
		for (const hidden of ["raw", "putInput", "appendEntryInternal", "changes", "invoker", "closing"])
			assert.equal(cast[hidden], undefined, `${hidden} must not exist on the callback surface`);
		assert.equal(Object.getPrototypeOf(tx), null);
	}, ctx);
	assert.equal(callbackArguments, 2, "internal transaction control must not reach a host callback");
	assert.throws(() => escaped!.config(1), /outside its callback/);
	assert.throws(() => escapedConfig!.get("profile"), /outside its callback/);
	const core = (fn: (tx: CoreTx) => unknown) => env.root.commit((tx) => fn(tx as unknown as CoreTx), ctx);
	await assert.rejects(
		core((tx) => tx.send(1, { content: "x" })),
		Forbidden,
	);
	await assert.rejects(
		core((tx) => tx.appendEntry(1, { kind: "x" })),
		Forbidden,
	);
	await assert.rejects(
		core((tx) => tx.sticky(1)),
		Forbidden,
	);
	await assert.rejects(
		core((tx) => tx.boundary(1, "final", undefined)),
		Forbidden,
	);
	await assert.rejects(
		core((tx) => tx.createTask(kinds.generation, { inputs: [] }, { conversationId: 1 })),
		Forbidden,
	);
	await assert.rejects(
		core((tx) => tx.checkpoint({ phase: "x" })),
		Forbidden,
	);
	await assert.rejects(
		core((tx) => tx.slot({ id: 1, kind: kinds.job })),
		Forbidden,
	);
	await env.root.commit((tx) => {
		tx.plugins(state).s = 1;
		tx.config(1).set("profile", "p2");
	}, ctx);
	assert.equal((await env.root.config.get(ctx)).profile, "p2");
});

// ---------------------------------------------------------------------------
// invocation tokens
// ---------------------------------------------------------------------------

test("an ordinary runtime cannot abort a task in an unrelated conversation", async () => {
	let target = 0;
	let result: unknown;
	const attacker = defineTask<null, { phase: "never" }, null, null, null>({
		name: "abort-attacker",
		async initial(_task, runtime, context) {
			try {
				result = await runtime.abortTask(target, context);
			} catch (error) {
				result = error;
			}
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
	const gate = new Gate();
	const env = await open({ taskKinds: [attacker], models: fake({ respond: echoScript, gate }) });
	onTestFinished(() => env.close());
	const active = await env.root.send({ content: "root" }, ctx);
	await gate.arrivals(1);
	target = (await env.tasks()).find((task) => task.kind === "pi.generation" && task.status !== "terminal")!.id;
	const foreign = await env.h.createConversation({}, ctx);
	const ref = await foreign.commit(
		(tx) => tx.createTask(attacker, null, { conversationId: foreign.id, background: true }),
		ctx,
	);
	await env.h.waitForTask(ref.id, ctx);
	assert.ok(result instanceof Forbidden);
	assert.equal((await env.h.getTask(target, ctx))?.abort, undefined);
	gate.open();
	assert.equal((await active.wait(ctx)).status, "done");
});

test("a captured runtime cannot commit after its invocation returned, after terminalization, or (run mode) after a durable mark", async () => {
	let captured: Runtime | undefined;
	const gate = new Gate();
	const k = defineTask<null, { phase: "x" }, null, null, null>({
		name: "cap",
		async initial(_t, rt, c) {
			captured = rt;
			await gate.wait(c);
			return { next: { phase: "x" } };
		},
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env = await open({ taskKinds: [k] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	await gate.arrivals(1);
	// marked while running: the run invocation's commits reject
	await env.h.markTask(ref.id, ctx);
	await assert.rejects(
		captured!.commit(() => 1, ctx),
		/marked run invocation|finished invocation/,
	); // the mark also signals the invocation, which may already have wound down
	gate.open();
	await env.h.waitForTask(ref.id, ctx);
	await assert.rejects(
		captured!.commit(() => 1, ctx),
		/finished invocation|not live/,
	);
	// a second kind whose invocation returns normally
	let cap2: Runtime | undefined;
	let child = 0;
	const k2 = defineTask<null, { phase: "x" }, null, null, null>({
		name: "cap2",
		async initial(_t, rt, context) {
			cap2 = rt;
			child = await rt.createOwnedConversation({}, context);
			return { next: { phase: "x" } };
		},
		phases: {
			async x() {
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const env2 = await open({ taskKinds: [k2] });
	onTestFinished(() => env2.close());
	const r2 = await env2.root.commit((tx) => tx.createTask(k2, null, { conversationId: 1, background: true }), ctx);
	await env2.h.waitForTask(r2.id, ctx);
	await assert.rejects(
		cap2!.commit(() => 1, ctx),
		Forbidden,
	);
	await assert.rejects(cap2!.createOwnedConversation({}, ctx), Forbidden);
	await assert.rejects(cap2!.sendOwned(child, { content: "late" }, ctx), Forbidden);
});

test("ToolDeclaration receives typed Static args; TypeBox 1.x validation rejects bad calls with a synthetic result", async () => {
	const schema = Type.Object({ n: Type.Number(), tags: Type.Optional(Type.Array(Type.String())) });
	const t: ToolDeclaration<typeof schema> = {
		name: "typed",
		description: "",
		parameters: schema,
		async execute(args) {
			return { content: [{ type: "text", text: `n=${args.n * 2} tags=${args.tags?.length ?? 0}` }] };
		},
	};
	const respond = (m: RequestMessage[]) => {
		const last = [...m].reverse().find((x) => x.role === "user" || x.role === "toolResult")!;
		if (last.role === "user") {
			const c = String((last as { content: unknown }).content);
			if (c === "good") return { toolCalls: [{ name: "typed", arguments: { n: 21, tags: ["a"] } }] };
			if (c === "bad") return { toolCalls: [{ name: "typed", arguments: { n: "x" } }] };
		}
		return { text: "ok" };
	};
	const env = await open({ tools: [t], models: fake({ respond }) });
	onTestFinished(() => env.close());
	await (await env.root.send({ content: "good" }, ctx)).wait(ctx);
	assert.match(
		JSON.stringify((await env.entries()).filter((e) => e.kind === "pi.tool_result").pop()!.model),
		/n=42 tags=1/,
	);
	await (await env.root.send({ content: "bad" }, ctx)).wait(ctx);
	const bad = (await env.entries()).filter((e) => e.kind === "pi.tool_result").pop()!;
	assert.match(JSON.stringify(bad.model), /invalid arguments: \/n: must be number/);
	assert.equal((bad.data as { diagnostics: { code: string }[] }).diagnostics[0]!.code, "invalid_arguments");
	const tasks = (await env.tasks()).filter((x) => x.kind === "pi.tool");
	assert.equal(resultOf<{ entry: number }>(tasks[1])?.entry, bad.id);
});
