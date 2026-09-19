import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { applyEnvelope, Harness } from "../../../src/harness/pico3/harness.ts";
import { JsonlStorage } from "../../../src/harness/pico3/jsonl.ts";
import { MemoryStorage } from "../../../src/harness/pico3/memory.ts";
import { defineTask, Faulted, type Storage, type Write } from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, open } from "./helpers.ts";

test("MemoryStorage validates a complete batch before publishing tables, documents, sequence, or id high-water", async () => {
	const storage = new MemoryStorage();
	const invalid: Write[] = [
		{ type: "conversation", conversation: { id: 40 } },
		{ type: "doc", ref: { doc: "session" }, ops: [["r", { plugins: { leaked: { value: true } } }]] },
		{ type: "entry", entry: { id: 40, conversationId: 40, kind: "duplicate-global-id" } },
	];
	await assert.rejects(storage.commit(invalid, ctx), /created twice/);
	assert.equal(await storage.conversation(40, ctx), undefined);
	assert.equal((await storage.entries([40], ctx)).size, 0);
	assert.deepEqual(await storage.doc({ doc: "session" }, ctx), { plugins: {} });

	await storage.commit([{ type: "conversation", conversation: { id: 1 } }], ctx);
	assert.equal(storage.mintId(), 2, "the rejected explicit id 40 did not move committed high-water");
	assert.equal(await storage.conversation(1, ctx).then((value) => value?.id), 1);
	await storage.close(ctx);
});

test("storage reads are isolated snapshots for every mutable durable family", async () => {
	const storage = new MemoryStorage();
	await storage.commit(
		[
			{ type: "conversation", conversation: { id: 1, sections: [{ key: "x", value: { nested: 1 } }] } },
			{
				type: "entry",
				entry: { id: 2, conversationId: 1, kind: "note", data: { nested: { value: 1 } } },
			},
			{
				type: "task",
				task: {
					id: 3,
					conversationId: 1,
					kind: "task",
					input: { nested: 1 },
					status: "pending",
					after: [],
					owns: [],
				},
			},
			{ type: "input", input: { id: 4, conversationId: 1, status: "queued", requestId: "r" } },
			{
				type: "doc",
				ref: { doc: "rewindable", conversationId: 1 },
				ops: [["r", { plugins: { p: { nested: { value: 1 } } } }]],
			},
		],
		ctx,
	);
	const conversation = await storage.conversation(1, ctx);
	const entry = (await storage.entries([2], ctx)).get(2)!;
	const task = await storage.task(3, ctx);
	const input = await storage.inputByRequest(1, "r", ctx);
	const document = await storage.doc({ doc: "rewindable", conversationId: 1 }, ctx);
	(conversation!.sections![0] as { value?: unknown }).value = "mutated";
	(entry.data!.nested as { value: number }).value = 9;
	(task!.input as { nested: number }).nested = 9;
	(input as { status: string }).status = "done";
	(document!.plugins as { p: { nested: { value: number } } }).p.nested.value = 9;

	assert.deepEqual((await storage.conversation(1, ctx))?.sections, [{ key: "x", value: { nested: 1 } }]);
	assert.deepEqual((await storage.entries([2], ctx)).get(2)?.data, { nested: { value: 1 } });
	assert.deepEqual((await storage.task(3, ctx))?.input, { nested: 1 });
	assert.equal((await storage.inputByRequest(1, "r", ctx))?.status, "queued");
	assert.deepEqual(await storage.doc({ doc: "rewindable", conversationId: 1 }, ctx), {
		plugins: { p: { nested: { value: 1 } } },
	});
	await storage.close(ctx);
});

test("a rejected persistence cut leaves mutated cached documents unpublished and faults the session", async () => {
	class RejectingStorage extends MemoryStorage {
		reject = false;
		override commit(writes: readonly Write[], context: Parameters<Storage["commit"]>[1]) {
			if (this.reject) return Promise.reject(new Error("publication cut"));
			return super.commit(writes, context);
		}
	}
	const storage = new RejectingStorage();
	const harness = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => harness.close(ctx).catch(() => {}));
	const state = harness.namespace<{ cut: { shouldNotPersist: boolean } }>("test.rejected-cut", {
		rewindable: { cut: { shouldNotPersist: false } },
	});
	harness.resume();
	const root = await harness.root(ctx);
	storage.reject = true;
	await assert.rejects(
		root.commit((tx) => {
			tx.plugins(state).cut = { shouldNotPersist: true };
		}, ctx),
		Faulted,
	);
	const stored = await storage.doc({ doc: "rewindable", conversationId: root.id }, ctx);
	assert.equal((stored?.plugins as { "test.rejected-cut"?: unknown })["test.rejected-cut"], undefined);
	await assert.rejects(root.write({ kind: "later" }, ctx), Faulted);
});

test("JSONL recovery discards a task sidecar tail when append fails before the sticky sidecar and publication marker", async () => {
	const never = defineTask<null, { phase: "never" }, null, null, null>({
		name: "never",
		async initial() {
			return { next: { phase: "never" } };
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
	const env = await open({ backend: "jsonl", taskKinds: [never] });
	onTestFinished(() => env.close().catch(() => {}));
	env.h.hold();
	const ref = await env.root.commit(
		(tx) => tx.createTask(never, null, { conversationId: env.root.id, background: true }),
		ctx,
	);
	await env.crash();
	let storage = await JsonlStorage.open(env.dir!, { fsync: false });
	const internals = storage as unknown as { append(fd: number, record: object): void };
	const append = internals.append.bind(storage);
	let appends = 0;
	internals.append = (fd, record) => {
		if (++appends === 2) throw new Error("injected sidecar append failure");
		append(fd, record);
	};
	await assert.rejects(
		storage.commit(
			[
				{ type: "task.patch", patch: { id: ref.id, status: "running", checkpoint: { phase: "started" } } },
				{
					type: "doc",
					ref: { doc: "sticky", conversationId: env.root.id },
					ops: [["s", ["followUpMode"], "all"]],
				},
			],
			ctx,
		),
		/injected sidecar append failure/,
	);
	await storage.close(ctx);
	storage = await JsonlStorage.open(env.dir!, { fsync: false });
	assert.equal((await storage.task(ref.id, ctx))?.status, "pending");
	assert.equal((await storage.task(ref.id, ctx))?.checkpoint, undefined);
	assert.equal(
		(await storage.doc({ doc: "sticky", conversationId: env.root.id }, ctx))?.followUpMode,
		"one-at-a-time",
	);
	await storage.close(ctx);
});

test("JSONL replay rejects a published marker whose expected sidecar record is missing", async () => {
	const env = await open({ backend: "jsonl" });
	onTestFinished(() => env.close().catch(() => {}));
	await env.root.config.set({ followUpMode: "all" } as never, ctx);
	await env.crash();
	const sidecar = join(env.dir!, "sticky-1.jsonl");
	const records = readFileSync(sidecar, "utf8").split("\n").filter(Boolean);
	assert.ok(records.length >= 2);
	writeFileSync(sidecar, `${records.slice(0, -1).join("\n")}\n`);

	let reopened: JsonlStorage | undefined;
	let replayError: unknown;
	try {
		reopened = await JsonlStorage.open(env.dir!, { fsync: false });
	} catch (error) {
		replayError = error;
	}
	await reopened?.close(ctx);
	assert.ok(replayError instanceof Error, "the main publication marker must require every named sidecar record");
});

test("unconfirmed JSONL tails are ignored and cannot advance committed id high-water", async () => {
	const env = await open({ backend: "jsonl" });
	onTestFinished(() => env.close().catch(() => {}));
	await env.root.write({ kind: "confirmed" }, ctx);
	await env.crash();
	const mainRecords = readFileSync(join(env.dir!, "main.jsonl"), "utf8").split("\n").filter(Boolean);
	const lastMain = JSON.parse(mainRecords.at(-1)!) as { seq: number; maxId: number };
	const sidecar = join(env.dir!, "sticky-999.jsonl");
	writeFileSync(
		sidecar,
		`${JSON.stringify({
			seq: lastMain.seq + 1,
			maxId: 999_999,
			writes: [
				{
					type: "doc",
					ref: { doc: "sticky", conversationId: 999 },
					ops: [["r", { inbox: [], turn: { tools: [] }, tasks: {}, plugins: {} }]],
				},
			],
		})}\n`,
	);
	const storage = await JsonlStorage.open(env.dir!, { fsync: false });
	assert.ok(storage.mintId() < 999_999);
	assert.equal(await storage.doc({ doc: "sticky", conversationId: 999 }, ctx), undefined);
	await storage.close(ctx);
});

test("fork state is commit-granular: an entry observes the final rewindable state of its atomic commit", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ version: string }>("test.fork-history", {
		rewindable: { version: "" },
	});
	const committed = await env.root.commit(async (tx) => {
		const input = await tx.write(env.root.id, { kind: "anchor" });
		tx.plugins(state).version = "same-commit-final";
		return input;
	}, ctx);
	const record = await env.input(committed);
	const fork = await env.root.fork(record!.entry!, {}, ctx);
	assert.equal((await fork.rewindable(ctx)).plugins["test.fork-history"]?.version, "same-commit-final");
});

test("active transcript capture preserves inherited head targets, inner heads, display-only entries, and edits verbatim", async () => {
	const storage = new MemoryStorage();
	const emptyRewindable = {
		thinkingLevel: "off",
		selectedTools: [],
		profile: "default",
		threshold: 0,
		keepRecent: 20_000,
		plugins: {},
	};
	const emptySticky = {
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		steeringMode: "all",
		followUpMode: "all",
		inbox: [],
		turn: { tools: [] },
		tasks: {},
		plugins: {},
	};
	await storage.commit(
		[
			{ type: "conversation", conversation: { id: 1 } },
			{ type: "doc", ref: { doc: "rewindable", conversationId: 1 }, ops: [["r", emptyRewindable]] },
			{ type: "doc", ref: { doc: "sticky", conversationId: 1 }, ops: [["r", emptySticky]] },
			{
				type: "entry",
				entry: {
					id: 2,
					conversationId: 1,
					kind: "pi.user",
					model: [{ role: "user", content: "base", timestamp: 1 }],
				},
			},
			{ type: "entry", entry: { id: 3, conversationId: 1, kind: "pi.summary", head: 2 } },
			{
				type: "entry",
				entry: { id: 4, conversationId: 1, kind: "pi.assistant", data: { reason: "aborted" } },
			},
			{
				type: "entry",
				entry: { id: 5, conversationId: 1, kind: "plugin.note", edits: [{ target: 2, action: "omit" }] },
			},
			{ type: "conversation", conversation: { id: 10, parent: { conversationId: 1, at: 5 } } },
			{ type: "doc", ref: { doc: "rewindable", conversationId: 10 }, ops: [["r", emptyRewindable]] },
			{ type: "doc", ref: { doc: "sticky", conversationId: 10 }, ops: [["r", emptySticky]] },
			{ type: "entry", entry: { id: 11, conversationId: 10, kind: "pi.handoff", head: 2 } },
		],
		ctx,
	);
	const harness = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => harness.close(ctx));
	harness.resume();
	const child = (await harness.conversation(10, ctx))!;
	const watch = await child.watch(ctx);
	let folded = watch.view;
	watch.start((envelope) => {
		folded = applyEnvelope(folded, envelope);
	});
	assert.deepEqual(
		watch.view.entries.map((entry) => entry.id),
		[2, 3, 4, 5, 11],
	);
	assert.deepEqual(watch.view.entries.find((entry) => entry.id === 5)?.edits, [{ target: 2, action: "omit" }]);
	assert.equal(watch.view.entries.find((entry) => entry.id === 4)?.model, undefined);
	const projected = await child.context(ctx);
	assert.equal(projected.head?.id, 11);
	assert.ok(
		!projected.entries.some((entry) => entry.id === 3),
		"model context drops inner heads while the view retains them",
	);

	await child.reset(undefined, ctx);
	const fresh = await child.watch(ctx);
	assert.deepEqual(folded.entries, fresh.view.entries);
	assert.equal(fresh.view.entries.length, 1);
	watch.stop();
	fresh.stop();
});

test("active transcript capture has no fixed page cap and crosses the head boundary on an older page", async () => {
	const storage = new MemoryStorage();
	const rewindable = {
		thinkingLevel: "off",
		selectedTools: [],
		profile: "default",
		threshold: 0,
		keepRecent: 20_000,
		plugins: {},
	};
	const sticky = {
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		steeringMode: "all",
		followUpMode: "all",
		inbox: [],
		turn: { tools: [] },
		tasks: {},
		plugins: {},
	};
	const writes: Write[] = [
		{ type: "conversation", conversation: { id: 1 } },
		{ type: "doc", ref: { doc: "rewindable", conversationId: 1 }, ops: [["r", rewindable]] },
		{ type: "doc", ref: { doc: "sticky", conversationId: 1 }, ops: [["r", sticky]] },
	];
	for (let id = 2; id <= 602; id++) writes.push({ type: "entry", entry: { id, conversationId: 1, kind: "history" } });
	writes.push({ type: "entry", entry: { id: 603, conversationId: 1, kind: "pi.summary", head: 100 } });
	await storage.commit(writes, ctx);
	const harness = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => harness.close(ctx));
	harness.resume();
	const watch = await (await harness.root(ctx)).watch(ctx);
	assert.equal(watch.view.entries.length, 504);
	assert.equal(watch.view.entries[0]?.id, 100);
	assert.equal(watch.view.entries.at(-1)?.id, 603);
	watch.stop();
});

test("newest in-range edit wins while the rendering transcript retains every edit verbatim", async () => {
	const storage = new MemoryStorage();
	const rewindable = {
		thinkingLevel: "off",
		selectedTools: [],
		profile: "default",
		threshold: 0,
		keepRecent: 20_000,
		plugins: {},
	};
	const sticky = {
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		steeringMode: "all",
		followUpMode: "all",
		inbox: [],
		turn: { tools: [] },
		tasks: {},
		plugins: {},
	};
	await storage.commit(
		[
			{ type: "conversation", conversation: { id: 1 } },
			{ type: "doc", ref: { doc: "rewindable", conversationId: 1 }, ops: [["r", rewindable]] },
			{ type: "doc", ref: { doc: "sticky", conversationId: 1 }, ops: [["r", sticky]] },
			{
				type: "entry",
				entry: {
					id: 2,
					conversationId: 1,
					kind: "pi.user",
					model: [{ role: "user", content: "original", timestamp: 1 }],
				},
			},
			{
				type: "entry",
				entry: {
					id: 3,
					conversationId: 1,
					kind: "edit.one",
					edits: [
						{ target: 2, action: "replace", messages: [{ role: "user", content: "older edit", timestamp: 2 }] },
					],
				},
			},
			{
				type: "entry",
				entry: {
					id: 4,
					conversationId: 1,
					kind: "edit.two",
					edits: [
						{ target: 2, action: "replace", messages: [{ role: "user", content: "newest edit", timestamp: 3 }] },
					],
				},
			},
		],
		ctx,
	);
	const harness = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => harness.close(ctx));
	harness.resume();
	const root = await harness.root(ctx);
	assert.equal((await root.context(ctx)).messages[0]?.content, "newest edit");
	const watch = await root.watch(ctx);
	assert.deepEqual(
		watch.view.entries.map((entry) => entry.edits),
		[
			undefined,
			[{ target: 2, action: "replace", messages: [{ role: "user", content: "older edit", timestamp: 2 }] }],
			[{ target: 2, action: "replace", messages: [{ role: "user", content: "newest edit", timestamp: 3 }] }],
		],
	);
	watch.stop();
});

test("open-time orphaning affects unknown live tasks but never rewrites an already-terminal unknown outcome", async () => {
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
					kind: "removed.kind",
					input: null,
					status: "running",
					after: [],
					owns: [],
				},
			},
			{
				type: "task",
				task: {
					id: 3,
					conversationId: 1,
					kind: "removed.kind",
					input: null,
					status: "terminal",
					outcome: { status: "completed", result: { retained: true } },
					after: [],
					owns: [],
				},
			},
		],
		ctx,
	);
	const harness = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => harness.close(ctx));
	harness.resume();
	assert.deepEqual((await harness.waitForTask(2, ctx)).outcome, { status: "orphaned" });
	assert.deepEqual((await harness.getTask(3, ctx))?.outcome, { status: "completed", result: { retained: true } });
});

test("terminal outcomes remain dependency evidence after retirement and JSONL reopen", async () => {
	const kind = defineTask<{ value: number }, { phase: "finish" }, { value: number }, null, null>({
		name: "spec.retained.dependency",
		async initial() {
			return { next: { phase: "finish" } };
		},
		phases: {
			async finish(task) {
				return { done: () => ({ status: "completed", result: { value: task.input.value } }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	let env = await open({ backend: "jsonl", taskKinds: [kind] });
	onTestFinished(() => env.close());
	const first = await env.root.commit(
		(tx) => tx.createTask(kind, { value: 1 }, { conversationId: 1, background: true }),
		ctx,
	);
	await env.h.waitForTask(first.id, ctx);
	for (let value = 2; value <= 30; value++) {
		const ref = await env.root.commit(
			(tx) => tx.createTask(kind, { value }, { conversationId: 1, background: true, after: [first.id] }),
			ctx,
		);
		await env.h.waitForTask(ref.id, ctx);
	}
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl", taskKinds: [kind] });
	const afterReopen = await env.root.commit(
		(tx) => tx.createTask(kind, { value: 31 }, { conversationId: 1, background: true, after: [first.id] }),
		ctx,
	);
	assert.deepEqual((await env.h.waitForTask(afterReopen.id, ctx)).outcome, {
		status: "completed",
		result: { value: 31 },
	});
	assert.deepEqual((await env.h.getTask(first.id, ctx))?.outcome, {
		status: "completed",
		result: { value: 1 },
	});
});
