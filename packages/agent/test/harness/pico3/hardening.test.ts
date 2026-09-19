import assert from "node:assert/strict";
import { test } from "vitest";
import { Bounded } from "../../../src/harness/pico3/bounded.ts";
import { Harness, kinds } from "../../../src/harness/pico3/harness.ts";
import { Membrane } from "../../../src/harness/pico3/membrane.ts";
import { MemoryStorage } from "../../../src/harness/pico3/memory.ts";
import { defineTask, Forbidden, type JsonObject, type JsonValue } from "../../../src/harness/pico3/types.ts";
import { ctx, fake, Gate, model, open, sleep } from "./helpers.ts";

test("MemoryStorage reads cannot mutate authoritative records", async () => {
	const storage = new MemoryStorage();
	await storage.commit(
		[
			{ type: "conversation", conversation: { id: 1 } },
			{ type: "entry", entry: { id: 2, conversationId: 1, kind: "original" } },
		],
		ctx,
	);
	const first = (await storage.entries([2], ctx)).get(2)!;
	(first as { kind: string }).kind = "mutated";
	assert.equal((await storage.entries([2], ctx)).get(2)!.kind, "original");
});

test("membrane rejects a wrapper hidden inside an assigned object and clones plain inputs", () => {
	const target: { left: JsonObject; right: JsonObject } = { left: {}, right: { value: 1 } };
	const membrane = new Membrane("nested");
	const view = membrane.wrap(target);
	const escaped = view.right;
	assert.throws(() => {
		view.left.payload = { escaped } as JsonValue;
	}, /document proxy/);
	const assigned = { nested: { value: 2 } };
	view.left.payload = assigned;
	assigned.nested.value = 3;
	assert.deepEqual(target.left.payload, { nested: { value: 2 } });
	membrane.revoke();
	assert.throws(() => view.left, /outside its transaction/);
});

test("tail bounds account for partial multi-chunk and single-chunk trimming", () => {
	const bytes = new Bounded(10, 100, "tail");
	bytes.push(new TextEncoder().encode("abcdefgh"));
	bytes.push(new TextEncoder().encode("ijklmnop"));
	assert.equal(bytes.text(), "ghijklmnop");
	assert.equal(bytes.droppedBytes, 6);

	const lines = new Bounded(100, 2, "tail");
	lines.push(new TextEncoder().encode("a\nb\nc\nd\n"));
	assert.equal(lines.text(), "c\nd\n");
	assert.equal(lines.droppedLines, 2);
});

test("terminal provider failure advances a queued follow-up without another send", async () => {
	const gate = new Gate();
	const env = await open({
		models: fake({ respond: () => ({ error: "fatal" }), gate }),
		root: { rewindable: { model }, sticky: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } } },
	});
	try {
		const first = await env.root.send({ content: "first" }, ctx);
		await gate.arrivals(1);
		const queued = await env.root.send({ content: "second" }, ctx);
		gate.open();
		await first.wait(ctx);
		await sleep(20);
		const current = await queued.result(ctx);
		assert.notEqual(current?.status, "queued");
		assert.ok(
			(await env.tasks()).some(
				(task) => task.kind === "pi.generation" && (task.input as { inputs: number[] }).inputs.includes(queued.id),
			),
		);
	} finally {
		gate.open();
		await env.close();
	}
});

test("ordinary Runtime off-line reads enforce conversation subtree scope", async () => {
	let observed: unknown;
	const probe = defineTask<{ foreign: number }, { phase: "done" }, null, null, null>({
		name: "scope-probe",
		async initial(task, runtime, context) {
			try {
				observed = await runtime.context(task.input.foreign, undefined, context);
			} catch (error) {
				observed = error;
			}
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
	const env = await open({ taskKinds: [probe] });
	try {
		const foreign = await env.h.createConversation({}, ctx);
		await foreign.write({ kind: "foreign" }, ctx);
		const ref = await env.root.commit(
			(tx) => tx.createTask(probe, { foreign: foreign.id }, { conversationId: 1, background: true }),
			ctx,
		);
		await env.h.waitForTask(ref.id, ctx);
		assert.ok(observed instanceof Forbidden, `ordinary task read foreign conversation: ${JSON.stringify(observed)}`);
	} finally {
		await env.close();
	}
});

test("unknown live task kinds are orphaned when resume begins", async () => {
	const storage = new MemoryStorage();
	await storage.commit(
		[
			{ type: "conversation", conversation: { id: 1 } },
			{ type: "doc", ref: { doc: "rewindable", conversationId: 1 }, ops: [["r", { plugins: {} }]] },
			{
				type: "doc",
				ref: { doc: "sticky", conversationId: 1 },
				ops: [["r", { inbox: [], turn: { tools: [] }, tasks: {}, plugins: {} }]],
			},
			{
				type: "task",
				task: {
					id: 2,
					conversationId: 1,
					kind: "missing.kind",
					input: null,
					status: "running",
					after: [],
					owns: [],
				},
			},
		],
		ctx,
	);
	const harness = await Harness.open(storage, { models: fake({ respond: () => ({ text: "ok" }) }) }, ctx);
	try {
		harness.resume();
		const task = await harness.waitForTask(2, ctx);
		assert.equal(task.status, "terminal");
		assert.equal(task.outcome?.status, "orphaned");
	} finally {
		await harness.close(ctx);
	}
});

test("a task kind registered after open but before resume recovers its durable tasks", async () => {
	const storage = new MemoryStorage();
	await storage.commit(
		[
			{ type: "conversation", conversation: { id: 1 } },
			{ type: "doc", ref: { doc: "rewindable", conversationId: 1 }, ops: [["r", { plugins: {} }]] },
			{
				type: "doc",
				ref: { doc: "sticky", conversationId: 1 },
				ops: [["r", { inbox: [], turn: { tools: [] }, tasks: {}, plugins: {} }]],
			},
			{
				type: "task",
				task: {
					id: 2,
					conversationId: 1,
					kind: "recover.after-open",
					input: null,
					status: "running",
					after: [],
					owns: [],
				},
			},
		],
		ctx,
	);
	const recovered = defineTask<null, { phase: "finish" }, string, null, null>({
		name: "recover.after-open",
		async initial() {
			return { next: { phase: "finish" } };
		},
		phases: {
			async finish() {
				return { done: () => ({ status: "completed", result: "replacement" }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	const harness = await Harness.open(storage, { models: fake({ respond: () => ({ text: "ok" }) }) }, ctx);
	try {
		harness.registerTaskKind(recovered);
		harness.resume();
		assert.deepEqual((await harness.waitForTask(2, ctx)).outcome, {
			status: "completed",
			result: "replacement",
		});
	} finally {
		await harness.close(ctx);
	}
});

void kinds;
