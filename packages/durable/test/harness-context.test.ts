import type { Context } from "@earendil-works/chord";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
	type ContextView,
	createRegistry,
	defineTask,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	type Storage,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addTask, assistant, describeMessage, openHarness, system, toolResult, user } from "./harness-support.ts";
import { context } from "./session-support.ts";

async function setup() {
	const { harness } = await openHarness(new MemoryStorage());
	const root = await harness.root(context);
	const append = (draft: EntryDraft): Promise<EntryRecord> =>
		root.commit((tx) => tx.appendEntry(root.id, draft), context);
	const message = (model: Message, kind = "message"): Promise<EntryRecord> => append({ kind, model: [model] });
	return { harness, root, append, message };
}

/** A Harness over MemoryStorage that counts scanned entry rows, with a 21-entry root transcript. */
async function countingSetup(options: { readonly settings?: HarnessSettings; readonly now?: () => number } = {}) {
	const scanned = { rows: 0 };
	/** When set, the next range scan waits for it; bounds probes (one row, on the Session line) do not. */
	const hold: { scan?: Promise<void> } = {};
	const memory = new MemoryStorage();
	const storage = new Proxy<Storage>(memory, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (key === "scanEntries") {
				return async (...args: Parameters<Storage["scanEntries"]>) => {
					const held = args[1] > 1 ? hold.scan : undefined;
					if (held !== undefined) hold.scan = undefined;
					await held;
					const page = await target.scanEntries(...args);
					scanned.rows += page.items.length;
					return page;
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const registry = createRegistry();
	const harness = await Harness.open(storage, { models: createModels(), registry, ...options }, context);
	const root = await harness.root(context);
	const first = await root.commit(
		(tx) => tx.appendEntry(root.id, { kind: "message", model: [user("first")] }),
		context,
	);
	for (let index = 0; index < 20; index++) {
		await root.commit(
			(tx) => tx.appendEntry(root.id, { kind: "message", model: [assistant(`old ${index}`)] }),
			context,
		);
	}
	return { harness, registry, root, first, scanned, hold };
}

function ids(entries: readonly EntryRecord[]): EntryId[] {
	return entries.map((entry) => entry.id);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("conversation context", () => {
	it("returns the whole transcript without a head and excludes model-less entries from messages", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("hi"));
		const note = await append({ kind: "note", data: { text: "display only" } });
		const answer = await message(assistant("hello"));
		const view = await root.context(context);
		expect(view.head).toBeUndefined();
		expect(ids(view.entries)).toEqual([first.id, note.id, answer.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:hi", "assistant:hello"]);
	});

	it("excludes aborted, error, and deferred assistant messages but keeps their raw entries", async () => {
		const { root, message } = await setup();
		await message(user("q"));
		const aborted = await message(assistant("partial", { stopReason: "aborted" }));
		await message(assistant("failed", { stopReason: "error" }));
		await message(assistant("later", { stopReason: "deferred" }));
		await message(assistant("done", { stopReason: "length" }));
		const view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.entries[1]!.id).toBe(aborted.id);
		expect(view.messages.map(describeMessage)).toEqual(["user:q", "assistant:done"]);
	});

	it("resolves self heads and uses the newest head marker", async () => {
		const { root, append, message } = await setup();
		await message(user("old"));
		const reset = await append({ kind: "reset", head: "self", model: [user("fresh start")] });
		expect(reset.head).toBe(reset.id);
		const after = await message(assistant("after reset"));
		let view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(ids(view.entries)).toEqual([reset.id, after.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:fresh start", "assistant:after reset"]);

		// A compaction summary heads an earlier kept entry; older head markers in range drop out.
		const summary = await append({ kind: "summary", head: after.id, model: [user("summary")] });
		const tail = await message(user("next"));
		view = await root.context(context);
		expect(view.head?.id).toBe(summary.id);
		expect(ids(view.entries)).toEqual([summary.id, after.id, tail.id]);
		expect(view.messages.map(describeMessage)).toEqual(["user:summary", "assistant:after reset", "user:next"]);
	});

	it("applies the newest edit per target within the active range", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("first"));
		const second = await message(user("second"));
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v2")] }] });
		await append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first v3")] }] });
		await append({ kind: "edit", edits: [{ target: second.id, action: "omit" }] });
		let view = await root.context(context);
		expect(view.entries).toHaveLength(5);
		expect(view.messages.map(describeMessage)).toEqual(["user:first v3"]);

		// Edits before the active range no longer apply.
		const reset = await append({ kind: "reset", head: second.id });
		view = await root.context(context);
		expect(view.head?.id).toBe(reset.id);
		expect(view.messages.map(describeMessage)).toEqual([]);
		await append({ kind: "edit", edits: [{ target: second.id, action: "replace", messages: [user("second v2")] }] });
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["user:second v2"]);
	});

	it("keeps positional system messages and orders tool results by call order", async () => {
		const { root, message, append } = await setup();
		await message(system({ preamble: "You help." }), "pi.system");
		await message(user("run tools"));
		await message(assistant("calling", { calls: ["b", "a"] }));
		await message(toolResult("a"));
		await append({ kind: "pi.system", model: [system({ cwd: "/repo" })] });
		await message(toolResult("b"));
		await message(toolResult("zz"));
		await message(assistant("done"));
		const view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:run tools",
			"assistant:calling",
			"result:b:result b",
			"result:a:result a",
			"system:cwd",
			"assistant:done",
		]);
	});

	// #10542
	it("leads with a system message that only user messages precede, and keeps later ones in place", async () => {
		const { root, message, append } = await setup();
		await message(user("first"));
		await message(user("steered"));
		await message(system({ preamble: "You help." }), "pi.system");
		await message(assistant("answer"));
		await message(user("next"));
		await message(system({ cwd: "/repo" }), "pi.system");
		let view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:first",
			"user:steered",
			"assistant:answer",
			"user:next",
			"system:cwd",
		]);
		// Stored order and contributions stay as committed.
		expect(view.contributions.flat().map(describeMessage).slice(0, 3)).toEqual([
			"user:first",
			"user:steered",
			"system:preamble",
		]);

		// After a reset, the baseline written after the handoff leads too.
		await append({ kind: "reset", head: "self", model: [user("handoff")] });
		await message(system({ preamble: "Baseline." }), "pi.system");
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["system:preamble", "user:handoff"]);
	});

	// #10904
	it("leads with the baseline after a compaction that keeps assistant messages", async () => {
		const { root, message, append } = await setup();
		await message(user("old"));
		const kept = await message(user("kept"));
		await message(assistant("calling", { calls: ["a"] }));
		await message(toolResult("a"));
		await message(assistant("answer"));
		await append({ kind: "summary", head: kept.id, model: [user("summary")] });
		await message(user("next"));
		await message(system({ preamble: "Baseline." }), "pi.system");
		let view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:summary",
			"user:kept",
			"assistant:calling",
			"result:a:result a",
			"assistant:answer",
			"user:next",
		]);

		// Later system messages stay in place.
		await message(assistant("done"));
		await message(system({ cwd: "/repo" }), "pi.system");
		view = await root.context(context);
		expect(view.messages.map(describeMessage).slice(0, 2)).toEqual(["system:preamble", "user:summary"]);
		expect(view.messages.map(describeMessage).slice(-2)).toEqual(["assistant:done", "system:cwd"]);
	});

	// #10904
	it("leads with a baseline written after the first answers, when the agent had no section or tool before", async () => {
		const { root, message } = await setup();
		await message(user("first"), "pi.user");
		await message(assistant("answer"), "pi.assistant");
		await message(user("next"), "pi.user");
		await message(system({ plan: "Plan." }), "pi.system");
		const view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:plan",
			"user:first",
			"assistant:answer",
			"user:next",
		]);
	});

	// #10904
	it("keeps system messages other than the baseline in place once an assistant message precedes them", async () => {
		const { root, message, append } = await setup();
		await message(user("first"));
		await message(assistant("answer"));
		// Another kind's system message is positional; the baseline after it is not the first system message.
		await message(system({ note: "From here on." }), "host.note");
		await message(system({ preamble: "Baseline." }), "pi.system");
		let view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"user:first",
			"assistant:answer",
			"system:note",
			"system:preamble",
		]);

		// After a compaction that keeps the other kind's system message, the new baseline does not move ahead of it.
		const kept = await message(user("kept"));
		await message(assistant("kept answer"));
		await message(system({ mode: "plan" }), "host.note");
		await append({ kind: "summary", head: kept.id, model: [user("summary")] });
		await message(user("next"));
		await message(system({ preamble: "Baseline." }), "pi.system");
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"user:summary",
			"user:kept",
			"assistant:kept answer",
			"system:mode",
			"user:next",
			"system:preamble",
		]);
	});

	// #10904
	it("does not lead with a first system entry written after another system message, even once that is omitted", async () => {
		const { root, message, append } = await setup();
		const host = await message(system({ legacy: "Use the legacy format." }), "host.system");
		await message(user("first"));
		await message(assistant("answer"));
		// Generation wrote this entry against the host's message: it only removes a section, so it is no baseline.
		await message(system({ legacy: null }), "pi.system");
		await append({ kind: "edit", edits: [{ target: host.id, action: "omit" }] });
		let view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["user:first", "assistant:answer", "system:legacy"]);

		// The same holds for a system message an edit put before it.
		const other = await setup();
		const first = await other.message(user("first"));
		await other.append({
			kind: "edit",
			edits: [{ target: first.id, action: "replace", messages: [user("first"), system({ note: "Note." })] }],
		});
		await other.message(assistant("answer"));
		await other.message(system({ note: null }), "pi.system");
		await other.append({ kind: "edit", edits: [{ target: first.id, action: "replace", messages: [user("first")] }] });
		view = await other.root.context(context);
		expect(view.messages.map(describeMessage)).toEqual(["user:first", "assistant:answer", "system:note"]);
	});

	// #10904
	it("does not lead with a retained, edited, or later system entry in place of the baseline", async () => {
		const { root, message, append } = await setup();
		const kept = await message(user("kept"));
		await message(assistant("answer"));
		const retained = await message(system({ cwd: "/repo" }), "pi.system");
		// Before generation writes the baseline after the head marker, a retained system entry stays in place.
		await append({ kind: "summary", head: kept.id, model: [user("summary")] });
		await message(user("next"));
		let view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"user:summary",
			"user:kept",
			"assistant:answer",
			"system:cwd",
			"user:next",
		]);

		// The baseline omits the retained entry, as generation writes it, and leads.
		const baseline = await append({
			kind: "pi.system",
			model: [system({ preamble: "Baseline." })],
			edits: [{ target: retained.id, action: "omit" }],
		});
		await message(assistant("done"));
		await message(system({ preamble: null }), "pi.system");
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"system:preamble",
			"user:summary",
			"user:kept",
			"assistant:answer",
			"user:next",
			"assistant:done",
			"system:preamble",
		]);

		// An omitted baseline leaves no message to lead; the delta after it is not a baseline and stays in place.
		await append({ kind: "edit", edits: [{ target: baseline.id, action: "omit" }] });
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"user:summary",
			"user:kept",
			"assistant:answer",
			"user:next",
			"assistant:done",
			"system:preamble",
		]);

		// A replacement of the baseline is not one either.
		await append({
			kind: "edit",
			edits: [{ target: baseline.id, action: "replace", messages: [system({ other: "Other." })] }],
		});
		view = await root.context(context);
		expect(view.messages.map(describeMessage)).toEqual([
			"user:summary",
			"user:kept",
			"assistant:answer",
			"user:next",
			"system:other",
			"assistant:done",
			"system:preamble",
		]);
	});

	it("synthesizes missing tool results after a fork and drops results cut from their call", async () => {
		const { root, message } = await setup();
		await message(user("go"));
		const call = await message(assistant("calling", { calls: ["x", "y"] }));
		await message(toolResult("x"));
		const second = await message(toolResult("y"));
		const child = await root.fork(call.id, { ownership: { kind: "ownerless" } }, context);
		const childView = await child.context(context);
		expect(childView.messages.map(describeMessage)).toEqual([
			"user:go",
			"assistant:calling",
			"result:x:error",
			"result:y:error",
		]);
		const missing = childView.messages[2]!;
		expect(missing).toMatchObject({
			role: "toolResult",
			toolName: "tool-x",
			details: { reason: "missing_result" },
		});

		// A head between a call and its results leaves stray results that are not sent.
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "reset", head: second.id }), context);
		const parentView = await root.context(context);
		expect(parentView.messages.map(describeMessage)).toEqual([]);
		expect(parentView.entries.map((entry) => entry.kind)).toEqual(["reset", "message"]);
	});

	// #10512
	it("reads the context as of an earlier entry, as a fork at that entry starts", async () => {
		const { root, append, message } = await setup();
		const first = await message(user("first"));
		const call = await message(assistant("calling", { calls: ["x", "y"] }));
		const result = await message(toolResult("x"));
		await message(toolResult("y"));
		const edit = await append({
			kind: "edit",
			edits: [{ target: first.id, action: "replace", messages: [user("first v2")] }],
		});
		const reset = await append({ kind: "reset", head: "self", model: [user("fresh start")] });
		const tail = await message(assistant("after reset"));

		for (const at of [first, call, result, edit, reset, tail]) {
			const fork = await root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
			expect(await root.context(context, { at: at.id })).toEqual(await fork.context(context));
		}
		// Stepped back before the edit and the reset: neither applies, and a cut call gets synthesized results.
		expect((await root.context(context, { at: call.id })).messages.map(describeMessage)).toEqual([
			"user:first",
			"assistant:calling",
			"result:x:error",
			"result:y:error",
		]);
		expect(await root.context(context, { at: tail.id })).toEqual(await root.context(context));
		expect(await root.context(context, {})).toEqual(await root.context(context));

		const other = await root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
		await expect(other.context(context, { at: tail.id })).rejects.toThrow("is not visible");
	});

	it("extends a task's context read with only newer entries", async () => {
		const { harness, registry, root, first, scanned } = await countingSetup();
		const Reads = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-reads",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const write = (draft: EntryDraft) =>
						runtime.commit(async (tx) => {
							await tx.appendEntry(root.id, draft);
							return undefined;
						}, taskContext);
					const read = async (at?: EntryId): Promise<{ view: ContextView; rows: number }> => {
						const before = scanned.rows;
						const view = await runtime.context(root.id, taskContext, { at });
						return { view, rows: scanned.rows - before };
					};
					const initial = await read();
					expect(initial.view).toEqual(await root.context(taskContext));

					// Three new entries: the bounds probe reads one row, the extension the three new ones.
					await write({ kind: "message", model: [user("new")] });
					await write({ kind: "note", data: { text: "display only" } });
					await write({ kind: "message", model: [assistant("answer")] });
					const extended = await read();
					expect(extended.rows).toBe(4);
					expect(extended.view).toEqual(await root.context(taskContext));

					// A newer edit of an older entry applies to the extended range.
					await write({ kind: "edit", edits: [{ target: first.id, action: "omit" }] });
					const edited = await read();
					expect(edited.rows).toBe(2);
					expect(edited.view).toEqual(await root.context(taskContext));
					expect(edited.view.messages.map(describeMessage)).not.toContain("user:first");

					// An earlier cutoff reuses the range.
					const cutoff = await read(extended.view.entries.at(-1)!.id);
					expect(cutoff.rows).toBe(0);
					expect(cutoff.view).toEqual(extended.view);

					// A new head marker changes the range: read it whole.
					await write({ kind: "reset", head: "self", model: [user("fresh")] });
					const reset = await read();
					expect(reset.view).toEqual(await root.context(taskContext));
					expect(reset.view.messages.map(describeMessage)).toEqual(["user:fresh"]);

					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						taskContext,
					);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
			},
		});
		addTask(registry, Reads);
		const id = await harness.commit(
			(tx) => tx.createTask(Reads, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		harness.resume();
		const settled = await harness.waitForTask(id, context);
		expect(settled.state.outcome).toEqual({ status: "completed", result: null });
		await harness.close(context);
	});

	it("keeps a conversation's context read across its tasks and for the retention period once idle", async () => {
		let clock = 1_000;
		const { harness, registry, root, scanned } = await countingSetup({ now: () => clock });
		const rows: Record<string, number> = {};
		const read = async (name: string, load: () => Promise<ContextView>, taskContext: Context) => {
			const before = scanned.rows;
			const view = await load();
			rows[name] = scanned.rows - before;
			expect(view).toEqual(await root.context(taskContext));
		};
		const Child = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-child",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					await runtime.commit(async (tx) => {
						await tx.appendEntry(root.id, { kind: "message", model: [user("from child")] });
						return undefined;
					}, taskContext);
					await read("child", () => runtime.context(root.id, taskContext), taskContext);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		const Parent = defineTask<Record<string, never>, { phase: "start" } | { phase: "after" }, null>({
			name: "test.context-parent",
			version: 1,
			initial: () => ({ phase: "start" }),
			phases: {
				start: async (_task, runtime, taskContext) => {
					await read("parent", () => runtime.context(root.id, taskContext), taskContext);
					await runtime.commit(async (tx) => {
						const child = await tx.createTask(
							Child,
							{},
							{ ownership: { kind: "task", taskId: runtime.taskId }, conversationId: root.id },
						);
						return { status: "waiting", checkpoint: { phase: "after" }, on: [child], policy: "allSettled" };
					}, taskContext);
				},
				after: async (_task, runtime, taskContext) => {
					await read("after", () => runtime.context(root.id, taskContext), taskContext);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		const Probe = probeTask(read);
		for (const task of [Child, Parent, Probe]) addTask(registry, task);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		const parent = await harness.commit((tx) => tx.createTask(Parent, {}, options), context);
		expect((await harness.waitForTask(parent, context)).state.outcome).toEqual(DONE.outcome);
		await root.waitForIdle(context);
		const probe = async (name: string) => {
			const id = await harness.commit((tx) => tx.createTask(Probe, { name }, options), context);
			expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
			await root.waitForIdle(context);
		};
		await probe("idle");
		clock += 600_000;
		await probe("expired");
		// Bounds probes read one row each. The child scans its own new entry; the waiting parent's later invocation and
		// the probe within the retention period scan nothing new. After it, the probe reads the whole transcript again.
		expect(rows).toEqual({ parent: 22, child: 2, after: 1, idle: 1, expired: 23 });
		await harness.close(context);
	});

	it("derives the same view from extended reads as from whole reads", async () => {
		const { harness, registry, root } = await countingSetup();
		// Deterministic pseudo-random transcript (32-bit LCG, high bits): calls and results in any order, missing and
		// stray results, excluded stop reasons, system entries, notes, edits of earlier entries, and head markers.
		let seed = 7;
		const random = (n: number) => {
			seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
			return Math.floor((seed / 2 ** 32) * n);
		};
		const seen = new Map<string, number>();
		const count = (category: string) => seen.set(category, (seen.get(category) ?? 0) + 1);
		const Steps = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-steps",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const written: EntryRecord[] = [];
					const calls: string[] = [];
					let next = 0;
					const draft = (): EntryDraft => {
						const pick = random(14);
						if (pick < 3) {
							count("user");
							return { kind: "message", model: [user(`u${next++}`)] };
						}
						if (pick < 5) {
							const ids = Array.from({ length: random(3) }, () => `c${next++}`);
							calls.push(...ids);
							const stopReason = (["aborted", "error", "deferred"] as const)[random(9)];
							count(stopReason ?? "assistant");
							return {
								kind: "message",
								model: [assistant(`a${next++}`, { calls: ids, ...(stopReason ? { stopReason } : {}) })],
							};
						}
						if (pick < 8) {
							const matched = calls.length > 0 && random(5) > 0;
							count(matched ? "result" : "stray result");
							const id = matched ? calls.splice(random(calls.length), 1)[0]! : `stray${next++}`;
							return { kind: "message", model: [toolResult(id)] };
						}
						if (pick < 9) {
							// `pi.system` entries can be the baseline that leads the context (#10904).
							const kind = random(2) === 0 ? "pi.system" : "message";
							count(kind === "pi.system" ? "baseline system" : "system");
							return { kind, model: [system({ s: `v${next++}` })] };
						}
						if (pick < 10) {
							count("note");
							return { kind: "note", data: { n: next++ } };
						}
						const target = written[random(written.length)];
						if (pick < 12 && target !== undefined) {
							const omit = random(2) === 0;
							count(omit ? "omit" : "replace");
							const action = omit
								? { action: "omit" as const }
								: { action: "replace" as const, messages: [user(`r${next++}`)] };
							return { kind: "edit", edits: [{ target: target.id, ...action }] };
						}
						if (pick < 13 && target !== undefined) {
							count("head");
							return { kind: "summary", head: target.id, model: [user(`h${next++}`)] };
						}
						count("user");
						return { kind: "message", model: [user(`u${next++}`)] };
					};
					const append = (conversationId: typeof root.id) =>
						runtime.commit(async (tx) => {
							const added = 1 + random(3);
							for (let index = 0; index < added; index++) {
								written.push(await tx.appendEntry(conversationId, draft()));
							}
							return undefined;
						}, taskContext);
					for (let step = 0; step < 150; step++) {
						await append(root.id);
						const whole = await root.context(taskContext);
						expect(await runtime.context(root.id, taskContext)).toEqual(whole);
						const contributed = whole.contributions.flat();
						const first = contributed.findIndex((message) => message.role === "system");
						if (
							first > 0 &&
							whole.messages[0] === contributed[first] &&
							contributed.slice(0, first).some((message) => message.role === "assistant")
						) {
							count("baseline past assistant");
						}
						if (step % 10 === 9) {
							// Overlapping reads, one with an earlier cutoff, share the kept range.
							const at = written[random(written.length)]!.id;
							const [whole, cut] = await Promise.all([
								runtime.context(root.id, taskContext),
								runtime.context(root.id, taskContext, { at }),
							]);
							expect(whole).toEqual(await root.context(taskContext));
							expect(cut).toEqual(await root.context(taskContext, { at }));
						}
					}
					// A fork sees its parent's entries through the fork point and extends with its own.
					const fork = await root.fork(
						written[random(written.length)]!.id,
						{ ownership: { kind: "ownerless" } },
						taskContext,
					);
					for (let step = 0; step < 20; step++) {
						expect(await runtime.context(fork.id, taskContext)).toEqual(await fork.context(taskContext));
						await append(fork.id);
					}
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		addTask(registry, Steps);
		harness.resume();
		const id = await harness.commit(
			(tx) => tx.createTask(Steps, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
		const categories = [
			"user",
			"assistant",
			"aborted",
			"error",
			"deferred",
			"result",
			"stray result",
			"system",
			"baseline system",
			"baseline past assistant",
			"note",
		];
		for (const category of [...categories, "omit", "replace", "head"]) expect(seen.get(category)).toBeGreaterThan(0);
		await harness.close(context);
	});

	// #10904
	it("finds the baseline among the entries an extended read adds", async () => {
		const { harness, registry, root, first, scanned } = await countingSetup();
		const Steps = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-baseline",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const append = (conversationId: typeof root.id, draft: EntryDraft) =>
						runtime.commit(async (tx) => {
							await tx.appendEntry(conversationId, draft);
							return undefined;
						}, taskContext);
					const read = async (conversation: typeof root) => {
						const before = scanned.rows;
						const view = await runtime.context(conversation.id, taskContext);
						const rows = scanned.rows - before;
						expect(view).toEqual(await conversation.context(taskContext));
						return { messages: view.messages.map(describeMessage), rows };
					};

					// The cached range has answers and no system message; the baseline arrives in a later read.
					expect((await read(root)).messages[0]).toBe("user:first");
					await append(root.id, { kind: "pi.system", model: [system({ plan: "Plan." })] });
					let read2 = await read(root);
					// One bounds probe and the added entry: the range was extended, not derived again.
					expect(read2.rows).toBe(2);
					expect(read2.messages.slice(0, 3)).toEqual(["system:plan", "user:first", "assistant:old 0"]);

					// A system message the cached range already has keeps a later first `pi.system` entry in place.
					const fork = await root.fork(first.id, { ownership: { kind: "ownerless" } }, taskContext);
					await append(fork.id, { kind: "message", model: [assistant("answer")] });
					await append(fork.id, { kind: "host.system", model: [system({ note: "Note." })] });
					expect((await read(fork)).messages).toEqual(["user:first", "assistant:answer", "system:note"]);
					await append(fork.id, { kind: "pi.system", model: [system({ note: null })] });
					read2 = await read(fork);
					expect(read2.rows).toBe(2);
					expect(read2.messages).toEqual(["user:first", "assistant:answer", "system:note", "system:note"]);

					// An omitted system message still rules out a later baseline; the extended read keeps that.
					const omitted = await root.fork(first.id, { ownership: { kind: "ownerless" } }, taskContext);
					await append(omitted.id, { kind: "message", model: [assistant("answer")] });
					let host: EntryRecord | undefined;
					await runtime.commit(async (tx) => {
						host = await tx.appendEntry(omitted.id, {
							kind: "host.system",
							model: [system({ legacy: "Legacy." })],
						});
						return undefined;
					}, taskContext);
					await append(omitted.id, { kind: "edit", edits: [{ target: host!.id, action: "omit" }] });
					expect((await read(omitted)).messages).toEqual(["user:first", "assistant:answer"]);
					await append(omitted.id, { kind: "pi.system", model: [system({ legacy: null })] });
					read2 = await read(omitted);
					expect(read2.rows).toBe(2);
					expect(read2.messages).toEqual(["user:first", "assistant:answer", "system:legacy"]);

					// A first `pi.system` entry without a system message leaves no baseline for a later one to take.
					const empty = await root.fork(first.id, { ownership: { kind: "ownerless" } }, taskContext);
					await append(empty.id, { kind: "pi.system" });
					await append(empty.id, { kind: "message", model: [assistant("answer")] });
					expect((await read(empty)).messages).toEqual(["user:first", "assistant:answer"]);
					await append(empty.id, { kind: "pi.system", model: [system({ s: "Delta." })] });
					read2 = await read(empty);
					expect(read2.rows).toBe(2);
					expect(read2.messages).toEqual(["user:first", "assistant:answer", "system:s"]);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		addTask(registry, Steps);
		harness.resume();
		const id = await harness.commit(
			(tx) => tx.createTask(Steps, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
		await harness.close(context);
	});

	it("keeps returned views and kept ranges apart", async () => {
		const { harness, registry, root } = await countingSetup();
		const Mutate = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-mutate",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const view = await runtime.context(root.id, taskContext);
					(view.messages as Message[]).length = 0;
					(view.entries as EntryRecord[]).pop();
					// Kept entries are frozen like MemoryStorage records.
					expect(() => {
						(view.contributions[0]![0] as { content: unknown }).content = "changed";
					}).toThrow(TypeError);
					expect(await runtime.context(root.id, taskContext)).toEqual(await root.context(taskContext));
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		addTask(registry, Mutate);
		harness.resume();
		const id = await harness.commit(
			(tx) => tx.createTask(Mutate, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
		await harness.close(context);
	});

	it("freezes kept entries deeply even when storage freezes them shallowly", async () => {
		const memory = new MemoryStorage();
		// Fresh copies with only the record itself frozen; their messages stay mutable.
		const storage = new Proxy<Storage>(memory, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (key === "scanEntries") {
					return async (...args: Parameters<Storage["scanEntries"]>) => {
						const page = await target.scanEntries(...args);
						return { ...page, items: page.items.map((item) => Object.freeze(structuredClone(item))) };
					};
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const registry = createRegistry();
		const harness = await Harness.open(storage, { models: createModels(), registry }, context);
		const root = await harness.root(context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "message", model: [user("hello")] }), context);
		const Mutate = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-shallow",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const view = await runtime.context(root.id, taskContext);
					expect(() => {
						(view.messages[0] as { content: unknown }).content = "changed";
					}).toThrow(TypeError);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		addTask(registry, Mutate);
		harness.resume();
		const id = await harness.commit(
			(tx) => tx.createTask(Mutate, {}, { ownership: { kind: "conversation" }, conversationId: root.id }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
		await harness.close(context);
	});

	it("does not keep a read that finishes after its task ended", async () => {
		const { harness, registry, root, scanned, hold } = await countingSetup({ settings: { contextRetentionMs: 0 } });
		const scans = Promise.withResolvers<void>();
		const probeStart = Promise.withResolvers<void>();
		let late: Promise<unknown> | undefined;
		const Late = defineTask<Record<string, never>, { phase: "run" }, null>({
			name: "test.context-late",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					hold.scan = scans.promise;
					late = runtime.context(root.id, taskContext).catch((error: unknown) => error);
					await runtime.commit(() => DONE, taskContext);
				},
			},
			abort: async (_task, runtime, taskContext) => {
				await runtime.commit(() => ABORTED, taskContext);
			},
		});
		const rows: Record<string, number> = {};
		const Probe = probeTask(async (name, load) => {
			await probeStart.promise;
			const before = scanned.rows;
			await load();
			rows[name] = scanned.rows - before;
		});
		for (const task of [Late, Probe]) addTask(registry, task);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		const lateId = await harness.commit((tx) => tx.createTask(Late, {}, options), context);
		expect((await harness.waitForTask(lateId, context)).state.outcome).toEqual(DONE.outcome);
		// The conversation is busy again when the late read finishes; its range must not be kept.
		const probeId = await harness.commit((tx) => tx.createTask(Probe, { name: "probe" }, options), context);
		scans.resolve();
		await late;
		probeStart.resolve();
		expect((await harness.waitForTask(probeId, context)).state.outcome).toEqual(DONE.outcome);
		expect(rows).toEqual({ probe: 22 });
		await harness.close(context);
	});

	it("drops an idle conversation's context read on a timer when nothing else runs", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const { harness, registry, root, scanned } = await countingSetup({ settings: { contextRetentionMs: 1_000 } });
		const rows: Record<string, number> = {};
		const Probe = probeTask(async (name, load) => {
			const before = scanned.rows;
			await load();
			rows[name] = scanned.rows - before;
		});
		addTask(registry, Probe);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		const probe = async (name: string) => {
			const id = await harness.commit((tx) => tx.createTask(Probe, { name }, options), context);
			expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
			await root.waitForIdle(context);
		};
		const idle = vi.getTimerCount();
		await probe("first");
		expect(vi.getTimerCount()).toBe(idle + 1);
		vi.advanceTimersByTime(1_000);
		expect(vi.getTimerCount()).toBe(idle);
		await probe("second");
		expect(rows).toEqual({ first: 22, second: 22 });
		await harness.close(context);
	});

	it("drops a conversation's context read once idle with zero retention", async () => {
		const { harness, registry, root, scanned } = await countingSetup({ settings: { contextRetentionMs: 0 } });
		const rows: Record<string, number> = {};
		const Probe = probeTask(async (name, load) => {
			const before = scanned.rows;
			await load();
			rows[name] = scanned.rows - before;
		});
		addTask(registry, Probe);
		harness.resume();
		const options = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
		for (const name of ["first", "second"]) {
			const id = await harness.commit((tx) => tx.createTask(Probe, { name }, options), context);
			expect((await harness.waitForTask(id, context)).state.outcome).toEqual(DONE.outcome);
			await root.waitForIdle(context);
		}
		expect(rows).toEqual({ first: 22, second: 22 });
		await harness.close(context);
	});
});

const DONE = { status: "terminal", outcome: { status: "completed", result: null } } as const;

const ABORTED = { status: "terminal", outcome: { status: "aborted" } } as const;

/** A task that reads its conversation's context once, named by its input. */
function probeTask(read: (name: string, load: () => Promise<ContextView>, taskContext: Context) => Promise<void>) {
	return defineTask<{ name: string }, { phase: "run" }, null>({
		name: "test.context-probe",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, taskContext) => {
				await read(task.input.name, () => runtime.context(runtime.conversationId, taskContext), taskContext);
				await runtime.commit(() => DONE, taskContext);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ABORTED, taskContext);
		},
	});
}
