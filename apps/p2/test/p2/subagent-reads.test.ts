// What the subagents worker (plugins/subagents/worker.ts) reads to report a subagent's run failure: `failureSource`
// decides, and the real worker facet, on a Durable double that counts reads, reads a subagent's live document only when
// it can have changed (first report, new entries, its work ended), so an idle subagent costs one entries read.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	CommitObserver,
	CommitPublication,
	ConversationId,
	EntryId,
	EntryRecord,
	LiveState,
	Observer,
	TaskGraph,
} from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { Subagents as Registry, type SubagentState } from "../../plugins/subagents/contract.worker.ts";
import subagentsWorker, { failureSource } from "../../plugins/subagents/worker.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { Server } from "../../src/runtime/chord.ts";
import { Extensions, type HarnessParts } from "../../src/runtime/worker.ts";
import { poll, testHost, workerFacet } from "./helpers.ts";

const id = (value: number) => value as EntryId;

describe("failureSource", () => {
	const known = { lastEntryId: id(7), updatedAt: 1, failure: { reason: "aborted" } };

	it("keeps the cached failure of an idle subagent: same newest entry, no end", () => {
		assert.deepEqual(failureSource(known, id(7), false), { kind: "cached", failure: { reason: "aborted" } });
		assert.deepEqual(failureSource({ ...known, failure: undefined }, id(7), false), {
			kind: "cached",
			failure: undefined,
		});
	});

	it("reads after a new entry", () => {
		assert.deepEqual(failureSource(known, id(8), false), { kind: "read" });
	});

	it("reads after its work ended without a new entry", () => {
		assert.deepEqual(failureSource(known, id(7), true), { kind: "read" });
	});

	it("reads a subagent the reports do not know yet (first report, worker start)", () => {
		assert.deepEqual(failureSource(undefined, id(7), false), { kind: "read" });
		assert.deepEqual(failureSource(undefined, undefined, false), { kind: "read" });
	});

	it("keeps the cached failure of a subagent without entries", () => {
		assert.deepEqual(failureSource({ ...known, lastEntryId: undefined }, undefined, false), {
			kind: "cached",
			failure: { reason: "aborted" },
		});
	});
});

/** Three subagents on a Durable double: every entries and live document read is counted by conversation. */
function durableDouble() {
	const agent = (conversationId: number) => ({
		conversationId: conversationId as ConversationId,
		model: "faux/faux-1",
		thinkingLevel: "off",
		tools: ["read"],
		reported: [],
	});
	const registry: SubagentState = { agents: { a: agent(2), b: agent(3), c: agent(4) }, reporters: {} };
	const entries = new Map<number, EntryRecord[]>([2, 3, 4].map((conversation) => [conversation, []]));
	const lives = new Map<number, LiveState>();
	const reads = { entries: [] as number[], live: [] as number[] };
	let nextEntry = 1;
	let commits: CommitObserver | undefined;
	let graph: Observer<TaskGraph> | undefined;
	const append = (conversation: number, text: string): void => {
		entries.get(conversation)?.push({
			id: id(nextEntry++),
			conversationId: conversation as ConversationId,
			kind: "pi.user",
			model: [{ role: "user", content: text, timestamp: nextEntry }],
		});
	};
	const durable = {
		snapshot: async (token: unknown, conversation: number) => {
			if (token === Registry) return registry;
			if (token === LiveDoc) {
				reads.live.push(conversation);
				return lives.get(conversation);
			}
			return undefined;
		},
		conversation: async (conversation: number) => ({
			id: conversation,
			entries: async (query: { minEntryId?: number }) => {
				reads.entries.push(conversation);
				const all = entries.get(conversation) ?? [];
				return { items: all.filter((entry) => entry.id >= (query.minEntryId ?? 0)).toReversed() };
			},
		}),
		observeCommits: (observer: CommitObserver) => {
			commits = observer;
			return { detach: () => {} };
		},
		observeTaskGraph: async (observer: Observer<TaskGraph>) => {
			graph = observer;
			return { value: { tasks: {} }, detach: () => {} };
		},
		commit: async () => {},
	};
	return {
		durable,
		reads,
		lives,
		/** A commit appending an entry to `conversation`, published as Durable publishes it. */
		write(conversation: number, text: string, ctx: Ctx): void {
			append(conversation, text);
			const change = { type: "entry", value: { conversationId: conversation } };
			commits?.advance({ seq: nextEntry, changes: [change] } as unknown as CommitPublication, ctx);
		},
		/** The task graph with foreground work on `busy`. */
		tasks(busy: readonly number[], ctx: Ctx): void {
			const tasks = Object.fromEntries(
				busy.map((conversation, index) => [index + 1, { conversationId: conversation, background: false }]),
			);
			graph?.advance({ kind: "value", value: { tasks } as unknown as TaskGraph, ops: [], retired: false }, ctx);
		},
		reset(): void {
			reads.entries.length = 0;
			reads.live.length = 0;
		},
	};
}

describe("the subagents worker's reads", () => {
	it("reads a live document only for a subagent with new entries or whose work ended", async (t) => {
		const double = durableDouble();
		const reports: { conversationId: number; failure?: { reason: string; detail?: string } }[][] = [];
		const fixture = await testHost({
			// At the server's address, so the stub of the server's `Subagents` takes the worker's reports in place.
			address: Server(),
			kind: "worker",
			facets: [workerFacet({ harness: { durable: double.durable } as unknown as HarnessParts }), subagentsWorker],
			stubs: [
				[
					Subagents,
					() => ({
						variant: "reporter",
						report: ({ children }: { children: (typeof reports)[number] }) => {
							reports.push(children);
							return null;
						},
					}),
				],
			],
		});
		t.after(() => fixture.close());
		// The worker's extensions, as its Harness holds them: holding them starts the subagent tools and their reporter.
		await fixture.host.registry(Extensions, BACKGROUND_CONTEXT);
		const sorted = (values: readonly number[]) => values.toSorted((a, b) => a - b);
		const report = async (count: number, what: string) => {
			await poll(() => reports.length >= count, 10_000, what);
			// Nothing else is pending: a later report would show in the counts below.
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(reports.length, count, `${what}: exactly one report`);
			return reports.at(-1)!;
		};
		const failureOf = (children: (typeof reports)[number], conversation: number) =>
			children.find((child) => child.conversationId === conversation)?.failure;

		// First report: every subagent is new, so each one's live document is read once.
		await report(1, "the first report");
		assert.deepEqual(sorted(double.reads.entries), [2, 3, 4]);
		assert.deepEqual(sorted(double.reads.live), [2, 3, 4]);

		// One subagent writes an entry: one entries read each, one live read (its own).
		await fixture.root(async (ctx) => {
			double.reset();
			double.write(2, "hello", ctx);
		});
		await report(2, "the report after an entry of a");
		assert.deepEqual(sorted(double.reads.entries), [2, 3, 4]);
		assert.deepEqual(double.reads.live, [2]);

		// b's run is stopped without an entry: its work ending wakes a report that reads only its live document.
		await fixture.root(async (ctx) => double.tasks([3], ctx));
		await fixture.root(async (ctx) => {
			double.reset();
			double.lives.set(3, { runFailure: { taskId: 1 as never, inputs: [], reason: "aborted" } });
			double.tasks([], ctx);
		});
		const stopped = await report(3, "the report after b's work ended");
		assert.deepEqual(sorted(double.reads.entries), [2, 3, 4]);
		assert.deepEqual(double.reads.live, [3]);
		assert.deepEqual(failureOf(stopped, 3), { reason: "aborted" });

		// a writes again: b's failure comes from the cache, unchanged, with no read of its live document.
		await fixture.root(async (ctx) => {
			double.reset();
			double.write(2, "again", ctx);
		});
		const later = await report(4, "the report after a's second entry");
		assert.deepEqual(sorted(double.reads.entries), [2, 3, 4]);
		assert.deepEqual(double.reads.live, [2]);
		assert.deepEqual(failureOf(later, 3), { reason: "aborted" });
		assert.equal(failureOf(later, 4), undefined);
	});
});
