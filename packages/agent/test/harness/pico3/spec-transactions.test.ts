import assert from "node:assert/strict";
import { withAbortSignal } from "@earendil-works/chord/context";
import { onTestFinished, test } from "vitest";
import { Harness, kinds } from "../../../src/harness/pico3/harness.ts";
import { MemoryStorage } from "../../../src/harness/pico3/memory.ts";
import {
	defineTask,
	type KindConfig,
	ReadAfterWrite,
	type Storage,
	type Write,
} from "../../../src/harness/pico3/types.ts";
import { ctx, echoScript, fake, Gate, open } from "./helpers.ts";

test("direct table reads and new-conversation document snapshots observe all same-batch creations", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const observed = await env.root.commit(async (tx) => {
		const inputId = await tx.write(1, { kind: "same-batch.entry", data: { value: 1 } });
		const input = await tx.input(inputId);
		const entry = await tx.entry(input!.entry!);
		const entries = await tx.entries([input!.entry!]);
		const task = tx.createTask(
			kinds.plugin,
			{ handler: "missing", input: null },
			{ conversationId: 1, background: true },
		);
		const conversationId = tx.createConversation({
			rewindable: { profile: "child-profile" },
			sticky: { followUpMode: "all" },
		});
		const conversation = await tx.conversation(conversationId);
		const taskRecord = await tx.task(task);
		return {
			conversationId,
			input,
			entry,
			entries: [...entries.values()],
			taskRecord,
			conversation,
			rewindable: tx.snapshot({ doc: "rewindable", conversationId }),
			sticky: tx.snapshot({ doc: "sticky", conversationId }),
		};
	}, ctx);
	assert.equal(observed.input?.status, "done");
	assert.deepEqual(observed.entry?.data, { value: 1 });
	assert.equal(observed.entries[0]?.id, observed.entry?.id);
	assert.equal(observed.taskRecord?.status, "pending");
	assert.equal(observed.conversation?.id, observed.conversationId);
	assert.equal(observed.rewindable.profile, "child-profile");
	assert.equal(observed.sticky.followUpMode, "all");
});

test("task patch and slot overlays are read-your-writes within one runtime commit", async () => {
	let observed: unknown;
	const kind = defineTask<null, { phase: "finish" }, null, null, null, object, KindConfig, { count: number }>({
		name: "spec.overlay.task",
		slot: () => ({ count: 0 }),
		async initial(_task, runtime, context) {
			observed = await runtime.commit(async (tx, current) => {
				tx.checkpoint({ phase: "finish" });
				const ref = { id: current.id, kind };
				const slot = tx.slot(ref);
				slot.count++;
				const direct = await tx.task(current.id);
				const typed = await tx.task(ref);
				const snapshot = tx.snapshot({ doc: "sticky", conversationId: current.conversationId });
				return {
					directPhase: direct?.checkpoint?.phase,
					typedPhase: typed?.checkpoint?.phase,
					slotCount: snapshot.tasks[current.id]?.count,
				};
			}, context);
			return { done: () => ({ status: "completed", result: null }) };
		},
		phases: {
			async finish() {
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
	await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(observed, { directPhase: "finish", typedPhase: "finish", slotCount: 1 });
});

test("checkpoint after same-commit owned conversation creation preserves the owns overlay", async () => {
	const gate = new Gate();
	const kind = defineTask<null, { phase: "finish"; child: number }, null, null, null>({
		name: "spec.overlay.owns",
		async initial() {
			return {
				next: (tx) => {
					const child = tx.createConversation({});
					tx.checkpoint({ phase: "finish", child });
					return { phase: "finish", child };
				},
			};
		},
		phases: {
			async finish(_task, _runtime, context) {
				await gate.wait(context);
				return { done: () => ({ status: "completed", result: null }) };
			},
		},
		async abort() {
			return () => null;
		},
	});
	let env = await open({ backend: "jsonl", taskKinds: [kind] });
	onTestFinished(() => env.close());
	const ref = await env.root.commit(
		(tx) => tx.createTask(kind, null, { conversationId: env.root.id, background: true }),
		ctx,
	);
	await gate.arrivals(1);
	const running = await env.h.getTask(ref.id, ctx);
	assert.deepEqual(running?.owns, [(running?.checkpoint as unknown as { child: number }).child]);
	gate.open();
	const terminal = await env.h.waitForTask(ref.id, ctx);
	assert.deepEqual(terminal.owns, running?.owns);
	const expected = structuredClone(terminal);
	await env.crash();
	env = await open({ backend: "jsonl", dir: env.dir, taskKinds: [kind] });
	assert.deepEqual(await env.h.getTask(ref.id, ctx), expected);
});

test("document reads keep a complete overlay while scan-shaped reads reject only affected domains", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ nested: { value: number } }>("test.transaction-overlay", {
		rewindable: { nested: { value: 0 } },
	});
	const other = await env.h.createConversation({}, ctx);
	await env.root.commit(async (tx) => {
		tx.plugins(state).nested = { value: 1 };
		tx.config(1).set("profile", "updated");
		assert.equal(tx.config(1).get("profile"), "updated");
		assert.deepEqual(tx.snapshot({ doc: "rewindable", conversationId: 1 }).plugins["test.transaction-overlay"], {
			nested: { value: 1 },
		});
		await tx.write(1, { kind: "root.write" });
		await tx.context(other.id);
		await tx.newestEntry(other.id);
		await tx.scanEntries({ conversationId: other.id, limit: 10 });
	}, ctx);

	await assert.rejects(
		env.root.commit(async (tx) => {
			await tx.write(1, { kind: "root.write.two" });
			await tx.context(1);
		}, ctx),
		ReadAfterWrite,
	);
	await assert.rejects(
		env.root.commit(async (tx) => {
			tx.createTask(kinds.plugin, { handler: "missing", input: null }, { conversationId: 1, background: true });
			await tx.tasks({ conversationId: other.id });
		}, ctx),
		ReadAfterWrite,
	);
});

test("a caught ReadAfterWrite poisons all buffered table and document writes and the next transaction starts clean", async () => {
	const env = await open({});
	onTestFinished(() => env.close());
	const state = env.h.namespace<{ poisoned: boolean; alsoPoisoned: boolean; clean: boolean }>(
		"test.transaction-poison",
		{ rewindable: { alsoPoisoned: false }, sticky: { poisoned: false, clean: false } },
	);
	let caught: unknown;
	await assert.rejects(
		env.root.commit(async (tx) => {
			tx.plugins(state).poisoned = true;
			await tx.write(1, { kind: "must.rollback" });
			try {
				await tx.scanEntries({ conversationId: 1, limit: 10 });
			} catch (error) {
				caught = error;
			}
			tx.plugins(state).alsoPoisoned = true;
			return "callback returned normally";
		}, ctx),
		ReadAfterWrite,
	);
	assert.ok(caught instanceof ReadAfterWrite);
	assert.equal((await env.root.sticky(ctx)).plugins["test.transaction-poison"], undefined);
	assert.equal((await env.root.rewindable(ctx)).plugins["test.transaction-poison"], undefined);
	assert.equal(
		(await env.entries()).some((entry) => entry.kind === "must.rollback"),
		false,
	);
	await env.root.commit((tx) => {
		tx.plugins(state).clean = true;
	}, ctx);
	assert.deepEqual((await env.root.sticky(ctx)).plugins["test.transaction-poison"], {
		poisoned: false,
		clean: true,
	});
});

test("a queued passive write does not poison entry scans because it has not changed the entry domain", async () => {
	const providerGate = new Gate();
	const env = await open({ models: fake({ respond: echoScript, gate: providerGate }) });
	onTestFinished(() => env.close());
	const active = await env.root.send({ content: "active" }, ctx);
	await providerGate.arrivals(1);
	const result = await env.root.commit(async (tx) => {
		const queued = await tx.write(1, { kind: "queued.passive" });
		const input = await tx.input(queued);
		const context = await tx.context(1);
		const newest = await tx.newestEntry(1);
		return { queued, input, contextIds: context.entries.map((entry) => entry.id), newest: newest?.id };
	}, ctx);
	assert.equal(result.input?.status, "queued");
	assert.ok(result.contextIds.includes(result.newest!));
	providerGate.open();
	await active.wait(ctx);
	assert.equal((await env.input(result.queued))?.status, "done");
});

test("callback-minted but uncommitted ids may be reused only after JSONL reopen", async () => {
	let env = await open({ backend: "jsonl" });
	onTestFinished(() => env.close());
	let abandoned = 0;
	await assert.rejects(
		env.root.commit(async (tx) => {
			abandoned = await tx.write(1, { kind: "abandoned" });
			throw new Error("discard transaction");
		}, ctx),
		/discard transaction/,
	);
	const sameProcess = await env.root.write({ kind: "same-process" }, ctx);
	assert.ok(sameProcess > abandoned, "the live storage instance does not recycle a minted id");
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl" });
	const afterReopen = await env.root.write({ kind: "after-reopen" }, ctx);
	assert.ok(afterReopen > sameProcess, "committed ids remain above high-water after reopen");

	let secondAbandoned = 0;
	await assert.rejects(
		env.root.commit(async (tx) => {
			secondAbandoned = await tx.write(1, { kind: "abandoned.two" });
			throw new Error("discard again");
		}, ctx),
		/discard again/,
	);
	await env.crash();
	env = await open({ dir: env.dir, backend: "jsonl" });
	assert.equal(await env.root.write({ kind: "reuses-uncommitted" }, ctx), secondAbandoned);
});

test("once persistence starts it is attempted exactly once with a non-cancellable context", async () => {
	class BlockingStorage extends MemoryStorage {
		block = false;
		attempts = 0;
		resolveStarted: (() => void) | undefined;
		readonly started = new Promise<void>((resolve) => {
			this.resolveStarted = resolve;
		});
		resolveRelease: (() => void) | undefined;
		readonly release = new Promise<void>((resolve) => {
			this.resolveRelease = resolve;
		});
		override async commit(writes: readonly Write[], context: Parameters<Storage["commit"]>[1]) {
			if (this.block) {
				this.attempts++;
				assert.equal(context.abortSignal, undefined);
				this.resolveStarted!();
				await this.release;
			}
			return super.commit(writes, context);
		}
	}
	const storage = new BlockingStorage();
	const harness = await Harness.open(storage, { models: fake({ respond: echoScript }) }, ctx);
	onTestFinished(() => harness.close(ctx));
	harness.resume();
	const root = await harness.root(ctx);
	storage.block = true;
	const controller = new AbortController();
	const operationContext = withAbortSignal(controller.signal, ctx);
	const write = root.write({ kind: "persist-despite-caller-cancel" }, operationContext);
	await storage.started;
	controller.abort(new Error("too late"));
	storage.resolveRelease!();
	const id = await write;
	assert.ok(id > 0);
	assert.equal(storage.attempts, 1);
	assert.equal(
		(await harness.entries({ conversationId: 1, limit: 100 }, ctx)).some(
			(entry) => entry.kind === "persist-despite-caller-cancel",
		),
		true,
	);
});
