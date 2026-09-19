import assert from "node:assert/strict";
import { withAbortSignal } from "@earendil-works/chord/context";
import { onTestFinished, test } from "vitest";
import { Harness, kinds } from "../../../src/harness/pico3/harness.ts";
import { MemoryStorage } from "../../../src/harness/pico3/memory.ts";
import {
	type CoreTx,
	defineTask,
	Faulted,
	type JsonObject,
	ReadAfterWrite,
	type Runtime,
	type Storage,
} from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, Gate, open } from "./helpers.ts";

/** Runs `fn` with core authority inside a generation's terminal closure? No: through a probe kind and a CoreTx cast, so reads/writes are the real ones. */
function coreProbe(
	name: string,
	body: (tx: CoreTx, rt: Runtime, cur: { conversationId: number; id: number }) => Promise<unknown>,
	out: { value?: unknown; error?: unknown },
) {
	return defineTask<null, { phase: "x" }, null, null, null>({
		name,
		async initial(_t, rt, c) {
			try {
				out.value = await rt.commit((tx, cur) => body(tx as unknown as CoreTx, rt, cur), c);
			} catch (e) {
				out.error = e;
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

test("read-your-writes: entry(id), task(ref) with later patches, conversation(id), input by request key all see same-batch writes", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const seen = await env.root.commit(async (tx) => {
		const w = await tx.write(1, { kind: "note", data: { n: 1 } }); // idle → appended immediately, input done
		const input = await tx.input(w);
		const entry = await tx.entry(input!.entry!);
		const ref = tx.createTask(
			kinds.plugin,
			{ handler: "none", input: null },
			{ conversationId: 1, background: true },
		);
		const task = await tx.task(ref);
		const conv = tx.createConversation({});
		const c = await tx.conversation(conv);
		return { inputStatus: input?.status, entryData: entry?.data, taskStatus: task?.status, convOk: c?.id === conv };
	}, ctx);
	assert.deepEqual(seen, { inputStatus: "done", entryData: { n: 1 }, taskStatus: "pending", convOk: true });
});

test("ReadAfterWrite: a scan after an append rejects, poisons the transaction even if caught, and nothing is persisted", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const before = (await env.entries()).length;
	let caught: unknown;
	await assert.rejects(
		env.root.commit(async (tx) => {
			await tx.write(1, { kind: "note" });
			try {
				await tx.newestEntry(1);
			} catch (e) {
				caught = e;
			}
			return "reached the end";
		}, ctx),
		ReadAfterWrite,
	);
	assert.ok(caught instanceof ReadAfterWrite);
	assert.equal((await env.entries()).length, before);
	// task scans after a task write; entry scans after a write to that conversation only
	await assert.rejects(
		env.root.commit(async (tx) => {
			tx.createTask(kinds.plugin, { handler: "x", input: null }, { conversationId: 1, background: true });
			await tx.tasks({});
		}, ctx),
		ReadAfterWrite,
	);
	const other = (await env.h.createConversation({}, ctx)).id;
	await env.root.commit(async (tx) => {
		await tx.write(1, { kind: "note" });
		await tx.newestEntry(other);
	}, ctx); // a different conversation's scan is fine
	await assert.rejects(
		env.root.commit(async (tx) => {
			await tx.write(1, { kind: "note" });
			await tx.context(1);
		}, ctx),
		ReadAfterWrite,
	);
	await assert.rejects(
		env.root.commit(async (tx) => {
			await tx.write(1, { kind: "note" });
			await tx.scanEntries({ conversationId: 1, limit: 5 });
		}, ctx),
		ReadAfterWrite,
	);
});

test("ReadAfterWrite from core code: a terminal closure that scanned after appending would be caught (probe)", async () => {
	const out: { error?: unknown } = {};
	const k = coreProbe(
		"scan-after",
		async (tx, _rt, cur) => {
			await tx.write(cur.conversationId, { kind: "note" });
			await tx.newestEntry(cur.conversationId, { withHead: true });
		},
		out,
	);
	const env = await open({ taskKinds: [k] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	await env.h.waitForTask(ref.id, ctx);
	assert.ok(out.error instanceof ReadAfterWrite);
});

test("config: defaults come from kind declarations; stored null is a value; unset restores the default; custom defaults are visible to c.config and to the task before any set", async () => {
	let seenByTask: unknown;
	const k = defineTask<
		null,
		{ phase: "x" },
		null,
		null,
		null,
		object,
		{ rewindable: { planMode: boolean; note: string | null } }
	>({
		name: "plan",
		config: { rewindable: { planMode: false, note: "n" } },
		async initial(_t, rt, c) {
			seenByTask = await rt.commit(
				(tx, cur) => [
					tx.config(cur.conversationId).get("planMode"),
					tx.snapshot({ doc: "rewindable", conversationId: cur.conversationId }).planMode,
				],
				c,
			);
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
	const cfg = env.root.config as unknown as {
		get(c: typeof ctx): Promise<Record<string, unknown>>;
		set(p: Record<string, unknown>, c: typeof ctx): Promise<void>;
		reset(keys: string[], c: typeof ctx): Promise<void>;
	};
	const all = await cfg.get(ctx);
	assert.equal(all.planMode, false);
	assert.equal(all.note, "n");
	assert.deepEqual(all.model, { provider: "anthropic", modelId: "fake-1" }); // set by the test harness root config; the only optional built-in
	assert.equal(all.threshold, 0);
	const ref = await env.root.commit((tx) => tx.createTask(k, null, { conversationId: 1, background: true }), ctx);
	await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(seenByTask, [false, false]); // both the facade and the document read see the default
	await cfg.set({ note: null }, ctx);
	assert.equal((await cfg.get(ctx)).note, null); // null stored, not "absent"
	await cfg.reset(["note"], ctx);
	assert.equal((await cfg.get(ctx)).note, "n"); // deleted → default
	await assert.rejects(cfg.set({ bogus: 1 }, ctx), /unknown config key/);
	// a rewound fork sees the defaults too
	const fork = await env.root.fork("start", {}, ctx);
	assert.equal(((await fork.config.get(ctx)) as Record<string, unknown>).planMode, false);
});

test("config: key collisions across kinds are rejected at installation", async () => {
	const clash = defineTask<null, { phase: "x" }, null, null, null, object, { sticky: { threshold: number } }>({
		name: "clash",
		config: { sticky: { threshold: 1 } },
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
		Harness.open(new MemoryStorage(), { models: fake({ respond: echoScript }), taskKinds: [clash] } as never, ctx),
		/declared by more than one kind/,
	);
	const partial = defineTask<null, { phase: "x" }, null, null, null>({
		...clash,
		name: "partial-clash",
		config: { rewindable: { partialKey: 1 }, sticky: { threshold: 1 } },
	});
	const env = await open({});
	onTestFinished(() => env.close());
	assert.throws(() => env.h.registerTaskKind(partial), /declared by more than one kind/);
	assert.equal("partialKey" in ((await env.root.config.get(ctx)) as Record<string, unknown>), false);
	const owner = defineTask<null, { phase: "x" }, null, null, null>({
		...clash,
		name: "partial-owner",
		config: { rewindable: { partialKey: 2 } },
	});
	const unregister = env.h.registerTaskKind(owner);
	assert.equal(((await env.root.config.get(ctx)) as Record<string, unknown>).partialKey, 2);
	unregister();
});

test("plugin state: registered namespace slices cannot see or clobber each other", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const a = env.h.namespace<{ count: number }>("a", { rewindable: { count: 0 } });
	const b = env.h.namespace<{ count: number }>("b", { rewindable: { count: 10 } });
	assert.throws(() => env.h.namespace("pi.x", {}), /invalid namespace/);
	await env.root.commit((tx) => {
		tx.plugins(a).count++;
		tx.plugins(b).count++;
	}, ctx);
	await assert.rejects(
		env.root.commit((tx) => {
			(tx.plugins(a) as JsonObject).typo = true;
		}, ctx),
		TypeError,
	);
	const rewindable = await env.root.rewindable(ctx);
	assert.deepEqual(rewindable.plugins, { a: { count: 1 }, b: { count: 11 } });
});

test("ordinary tasks can directly read entries inherited by their fork conversation", async () => {
	let observed: number[] = [];
	const reader = defineTask<{ entry: number }, { phase: "never" }, null, null, null>({
		name: "fork-entry-reader",
		async initial(task, runtime, context) {
			observed = await runtime.commit(async (tx) => {
				const direct = await tx.entry(task.input.entry);
				const many = await tx.entries([task.input.entry]);
				return [direct?.id, many.get(task.input.entry)?.id].filter((id): id is number => id !== undefined);
			}, context);
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
	const env = await open({ taskKinds: [reader] });
	onTestFinished(() => env.close());
	const result = await (await env.root.send({ content: "parent" }, ctx)).wait(ctx);
	const inherited = (await env.entries()).find((entry) => entry.kind === "pi.user")!;
	const fork = await env.root.fork(result.answer!, {}, ctx);
	const ref = await fork.commit(
		(tx) => tx.createTask(reader, { entry: inherited.id }, { conversationId: fork.id, background: true }),
		ctx,
	);
	await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(observed, [inherited.id, inherited.id]);
});

test("session line: a storage commit failure faults the session; later operations reject Faulted; a callback failure before persistence does not fault", async () => {
	class Flaky extends MemoryStorage {
		fail = false;
		override async commit(w: Parameters<Storage["commit"]>[0], c: Parameters<Storage["commit"]>[1]) {
			if (this.fail) throw new Error("disk full");
			return super.commit(w, c);
		}
	}
	const storage = new Flaky();
	const h = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => h.close(ctx).catch(() => {}));
	h.resume();
	const root = await h.root(ctx);
	await assert.rejects(
		root.commit(() => {
			throw new Error("mine");
		}, ctx),
		/mine/,
	);
	await root.write({ kind: "note" }, ctx); // still fine
	storage.fail = true;
	await assert.rejects(root.write({ kind: "note" }, ctx), Faulted);
	await assert.rejects(root.write({ kind: "note" }, ctx), Faulted);
	await assert.rejects(root.rewindable(ctx), Faulted);
});

test("session line: listener throws never reach the writer; nested line entry rejects; cancellation is checked before the callback", async () => {
	const reports: unknown[] = [];
	const env = await open({ onReport: (e) => reports.push(e) });
	onTestFinished(() => env.close());
	const w = await env.root.watch(ctx);
	w.start(() => {
		throw new Error("listener boom");
	});
	await env.root.write({ kind: "note" }, ctx); // resolves
	assert.equal(w.closed, true);
	assert.match(String(reports[0]), /listener boom/);
	await assert.rejects(
		env.root.commit((tx, lineCtx) => env.root.commit(() => tx.input(1), lineCtx), ctx),
		/nested line operation/,
	);
	const ac = new AbortController();
	const cctx = withAbortSignal(ac.signal, ctx);
	ac.abort(new Error("cancelled"));
	await assert.rejects(env.root.write({ kind: "note" }, cctx), /cancelled/);
	const gate = new Gate();
	const p = env.root.commit(async () => {
		await gate.wait(ctx);
	}, ctx);
	const ac2 = new AbortController();
	const cctx2 = withAbortSignal(ac2.signal, ctx);
	const queued = env.root.write({ kind: "note" }, cctx2); // queued behind p
	ac2.abort(new Error("late cancel"));
	gate.open();
	await p;
	await assert.rejects(queued, /late cancel/); // checked again when it reaches the line
});
