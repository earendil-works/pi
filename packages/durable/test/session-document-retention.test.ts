// The Session's document cache is bounded by use: unattached documents leave it after the retention period and load
// from Storage again; documents with a watch or a document state never leave it.
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineDoc,
	defineDocFamily,
	defineTool,
	type HarnessSettings,
	type LiveState,
	MemoryStorage,
	type Seq,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished } from "vitest";
import { SessionImpl, setDefaultDocumentRetention } from "../src/session/session.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { viewHistory } from "./live-support.ts";
import { ControlledStorage, context, createConversation, onValue } from "./session-support.ts";
import { deferred, eventually } from "./task-support.ts";

type Counter = { count: number };
const CounterDoc = defineDoc<Counter>({
	checkpointWhen: () => false,
	kind: "test.retention.counter",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ count: 0 }),
});
const RewindableDoc = defineDoc<Counter>({
	checkpointWhen: () => false,
	kind: "test.retention.rewindable",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ count: 0 }),
});
/** A third-party conversation family: one member per event. */
const EventDoc = defineDocFamily<{ seq: number }, number>({
	checkpointWhen: () => false,
	kind: "test.retention.event",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seq) => ({ seq }),
});
const SessionCounterDoc = defineDoc<Counter>({
	checkpointWhen: () => false,
	kind: "test.retention.session-counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
});

/** A session document whose checkpoint predicate throws, so the commit that changes it fails while it settles. */
const Failing = defineDoc<Counter>({
	kind: "test.retention.failing",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
	checkpointWhen: () => {
		throw new Error("checkpoint failed");
	},
});

/** The default retention of this run, as the setup file set it. */
const defaultForRun =
	process.env.PI_DURABLE_DOCUMENT_RETENTION_MS === undefined
		? 600_000
		: Number(process.env.PI_DURABLE_DOCUMENT_RETENTION_MS);

/** A conversation document any Harness test can read. */
const TestDoc = defineDoc<Counter>({
	checkpointWhen: () => false,
	kind: "test.retention.harness",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ count: 0 }),
});

/** A Session with a controllable clock and retention. */
function open(retentionMs: number) {
	const clock = { now: 1_000 };
	const storage = new ControlledStorage();
	const session = new SessionImpl(
		storage,
		() => clock.now,
		() => retentionMs,
	);
	const sizes = () => session.documentCacheSizes;
	return { storage, session, clock, sizes };
}

/** Let the line run what is queued on it: an eviction job, then return. */
async function settleLine(session: SessionImpl): Promise<void> {
	await session.readOnLine(async () => {});
}

async function bump(session: SessionImpl, conversationId: ConversationId, by = 1): Promise<void> {
	await session.commit(async (tx) => {
		(await tx.doc(CounterDoc, conversationId)).count += by;
	}, context);
}

describe("document cache retention", () => {
	it("evicts an unattached document once its retention passed, and loads it again with the same value", async () => {
		const { session, storage, clock, sizes } = open(60_000);
		const conversationId = await createConversation(session);
		await bump(session, conversationId, 3);
		expect(sizes().cached).toBeGreaterThan(0);
		// Not yet: inside the retention period.
		clock.now += 59_000;
		await bump(session, conversationId, 0);
		await settleLine(session);
		expect(sizes().cached).toBeGreaterThan(0);
		// Past it, with no use since: the next commit evicts it.
		clock.now += 61_000;
		await session.commit(async () => {}, context);
		await session.commit(async (tx) => {
			await tx.doc(SessionCounterDoc);
		}, context);
		await settleLine(session);
		const reads = storage.documentReadCount;
		expect(await session.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 3 });
		expect(storage.documentReadCount).toBeGreaterThan(reads);
		await session.close(context);
	});

	it("evicts with retention 0 right after use, on the line", async () => {
		const { session, sizes } = open(0);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		await eventually(async () => {
			await settleLine(session);
			return sizes().cached === 0;
		});
		expect(await session.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 1 });
		await session.close(context);
	});

	it("never evicts a document a watch observes, and evicts it once the last watch detaches", async () => {
		const { session, storage, clock, sizes } = open(1_000);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		const watch = (await session.watchDoc(CounterDoc, conversationId, context))!;
		const kept = (await session.watchDoc(CounterDoc, conversationId, context))!;
		kept.start(async () => {});
		const seen: number[] = [];
		watch.start(
			onValue(async ({ value }) => {
				seen.push(value.count);
			}),
		);
		clock.now += 1_000_000;
		await bump(session, conversationId);
		await settleLine(session);
		// Still cached: a read long after its retention passed loads nothing from Storage.
		await eventually(() => seen.includes(2) && kept.value.count === 2);
		const reads = storage.documentReadCount;
		clock.now += 1_000_000;
		await session.commit(async (tx) => {
			await tx.doc(SessionCounterDoc);
		}, context);
		await settleLine(session);
		expect(await session.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 2 });
		expect(storage.documentReadCount).toBe(reads);
		await watch.stop();
		clock.now += 1_000_000;
		await bump(session, conversationId);
		await settleLine(session);
		await eventually(() => kept.value.count === 3);
		await kept.stop();
		clock.now += 1_000_000;
		await session.commit(async () => {}, context);
		await session.commit(async (tx) => {
			await tx.doc(SessionCounterDoc);
		}, context);
		await settleLine(session);
		// The session document was just used; the counter is gone.
		expect(sizes().cached).toBe(1);
		await session.close(context);
	});

	it("never takes a tracker from a transaction that holds it", async () => {
		const { session, clock } = open(0);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		const inside = deferred();
		const release = deferred();
		const commit = session.commit(async (tx) => {
			const draft = await tx.doc(CounterDoc, conversationId);
			inside.resolve();
			await release.promise;
			draft.count += 10;
		}, context);
		await inside.promise;
		// Retention passes while the transaction holds the document; eviction waits on the line behind it.
		clock.now += 1_000_000;
		release.resolve();
		await commit;
		expect(await session.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 11 });
		await bump(session, conversationId);
		expect(await session.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 12 });
		await session.close(context);
	});

	it("writes after a reload continue the stored deltas and bases", async () => {
		const { session, storage } = open(0);
		const conversationId = await createConversation(session);
		const writes: StorageWrite[][] = [];
		const commit = storage.commit.bind(storage);
		storage.commit = (batch: readonly StorageWrite[], adopt: (seq: Seq) => void, commitContext: Context) => {
			writes.push([...batch]);
			return commit(batch, adopt, commitContext);
		};
		for (let n = 0; n < 5; n++) {
			await bump(session, conversationId);
			await settleLine(session);
		}
		expect(await session.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 5 });
		// Every bump after the first is a change of the same incarnation, never a second creation.
		const creations = writes
			.flat()
			.filter((write) => write.type === "document.create" && write.record.kind === CounterDoc.definition.kind);
		expect(creations).toHaveLength(1);
		await session.close(context);
		// And a fresh Session over the same storage reads the same value.
		const reopened = new SessionImpl(storage.reopen(), Date.now, () => 0);
		expect(await reopened.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 5 });
		await reopened.close(context);
	});

	it("keeps history and forks of rewindable documents after eviction", async () => {
		const { session } = open(0);
		const conversationId = await createConversation(session);
		const first = await session.commit(async (tx) => {
			(await tx.doc(RewindableDoc, conversationId)).count = 1;
			return (await tx.appendEntry(conversationId, { kind: "note", data: null })).id;
		}, context);
		await settleLine(session);
		const second = await session.commit(async (tx) => {
			(await tx.doc(RewindableDoc, conversationId)).count = 2;
			return (await tx.appendEntry(conversationId, { kind: "note", data: null })).id;
		}, context);
		await settleLine(session);
		expect(await session.snapshotAsOf(RewindableDoc, conversationId, first, context)).toEqual({ count: 1 });
		expect(await session.snapshotAsOf(RewindableDoc, conversationId, second, context)).toEqual({ count: 2 });
		const fork = await session.commit(
			async (tx) => (await tx.forkConversation(conversationId, first, { ownership: { kind: "ownerless" } })).id,
			context,
		);
		await settleLine(session);
		expect(await session.snapshot(RewindableDoc, fork, context)).toEqual({ count: 1 });
		expect(await session.snapshot(RewindableDoc, conversationId, context)).toEqual({ count: 2 });
		await session.close(context);
	});

	it("bounds a third-party family with a member per event", async () => {
		const { session, sizes } = open(0);
		const conversationId = await createConversation(session);
		for (let seq = 0; seq < 200; seq++) {
			await session.commit(async (tx) => {
				await tx.doc(EventDoc, conversationId, String(seq), seq);
			}, context);
		}
		await eventually(async () => {
			await settleLine(session);
			return sizes().cached === 0;
		});
		expect(await session.snapshot(EventDoc, conversationId, "123", context)).toEqual({ seq: 123 });
		await session.close(context);
	});

	it("keeps the cache of a long-lived Session bounded across many conversations", async () => {
		const { session, clock, sizes } = open(10_000);
		for (let n = 0; n < 300; n++) {
			const conversationId = await createConversation(session);
			await bump(session, conversationId);
			clock.now += 1_000;
		}
		await settleLine(session);
		// Only what was used in the last 10 s, about ten conversations' worth.
		expect(sizes().cached).toBeLessThanOrEqual(12);
		await session.close(context);
	});

	it("never changes the outcome of a commit when the clock throws", async () => {
		const clock = { now: 1_000, fail: false };
		const storage = new ControlledStorage();
		const session = new SessionImpl(
			storage,
			() => {
				if (clock.fail) throw new Error("clock");
				return clock.now;
			},
			() => 0,
		);
		const conversationId = await createConversation(session);
		clock.fail = true;
		await bump(session, conversationId, 42);
		clock.fail = false;
		expect(await session.snapshot(CounterDoc, conversationId, context)).toEqual({ count: 42 });
		await session.close(context);
	});

	it("evicts after a commit whose settlement fails", async () => {
		const { session, clock, sizes } = open(10_000);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		// Created first: the predicate runs only for changes to an existing document.
		await session.commit((tx) => tx.doc(Failing).then(() => undefined), context);
		await settleLine(session);
		// Retention passes inside a commit whose checkpoint predicate throws while it settles.
		await expect(
			session.commit(async (tx) => {
				(await tx.doc(Failing)).count++;
				clock.now += 1_000_000;
			}, context),
		).rejects.toThrow("checkpoint failed");
		expect(sizes().cached).toBe(0);
		await session.close(context);
	});

	it("evicts promptly once the retention is shortened", async () => {
		const retention = { ms: 600_000 };
		const storage = new ControlledStorage();
		const clock = { now: 1_000 };
		const session = new SessionImpl(
			storage,
			() => clock.now,
			() => retention.ms,
		);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		retention.ms = 0;
		clock.now += 2_000;
		// A read, no commit: the sweep pending for ten minutes from now moves up.
		await session.snapshot(CounterDoc, conversationId, context);
		await eventually(async () => {
			await settleLine(session);
			return session.documentCacheSizes.cached === 0;
		});
		await session.close(context);
	});

	it("pins only what is at the address a watch follows: nothing while retired, then the new incarnation", async () => {
		const { session, sizes } = open(0);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		const watch = (await session.watchDoc(CounterDoc, conversationId, context))!;
		watch.start(async () => {});
		await session.commit((tx) => tx.retireDoc(CounterDoc, conversationId), context);
		await eventually(async () => {
			await settleLine(session);
			return sizes().cached === 0;
		});
		expect(sizes().attached).toBe(0);
		await bump(session, conversationId, 5);
		await settleLine(session);
		expect(sizes()).toMatchObject({ cached: 1, attached: 1 });
		await eventually(async () => watch.value.count === 5);
		await watch.stop();
		await eventually(async () => {
			await settleLine(session);
			return sizes().cached === 0;
		});
		await session.close(context);
	});

	it("leaves no pin behind when an observer's load loses a race with close", async () => {
		const { session, storage } = open(0);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		await eventually(async () => {
			await settleLine(session);
			return session.documentCacheSizes.cached === 0;
		});
		const gate = storage.holdFindDocument();
		const attaching = session.watchDoc(CounterDoc, conversationId, context);
		await gate.entered;
		const closing = session.close(context);
		gate.release();
		await expect(attaching).rejects.toThrow();
		await closing;
		expect(session.documentCacheSizes).toMatchObject({ cached: 0, idle: 0, attached: 0 });
	});

	it("evicts on its timer without a commit, and tolerates a stop called twice", async () => {
		const storage = new ControlledStorage();
		const session = new SessionImpl(storage, Date.now, () => 20);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		const watch = (await session.watchDoc(CounterDoc, conversationId, context))!;
		await watch.stop();
		await watch.stop();
		const until = Date.now() + 2_000;
		while (session.documentCacheSizes.cached > 0 && Date.now() < until)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.documentCacheSizes.cached).toBe(0);
		await session.close(context);
	});

	it("migrates a document again after its eviction", async () => {
		const V1 = defineDoc<{ count: number }>({
			checkpointWhen: () => false,
			kind: "test.retention.migrating",
			version: 1,
			scope: "session",
			initial: () => ({ count: 1 }),
		});
		let migrations = 0;
		const V2 = defineDoc<{ count: number; migrated: boolean }>({
			checkpointWhen: () => false,
			kind: "test.retention.migrating",
			version: 2,
			scope: "session",
			initial: () => ({ count: 0, migrated: true }),
			migrate: (value) => {
				migrations++;
				return { count: (value as { count: number }).count, migrated: true };
			},
		});
		const { session } = open(0);
		await session.commit((tx) => tx.doc(V1).then(() => undefined), context);
		await settleLine(session);
		expect(await session.snapshot(V2, context)).toEqual({ count: 1, migrated: true });
		await settleLine(session);
		expect(await session.snapshot(V2, context)).toEqual({ count: 1, migrated: true });
		// Not written back, so each cold load migrates again.
		expect(migrations).toBe(2);
		await session.close(context);
	});

	it("treats a retention that is not a number of milliseconds as the default, and Infinity as never", async () => {
		// The default as shipped, also in the suite run that forces another.
		setDefaultDocumentRetention(600_000);
		onTestFinished(() => setDefaultDocumentRetention(defaultForRun));
		for (const retention of [Number.NaN, -5, "soon" as unknown as number]) {
			const { session, clock, sizes } = open(retention);
			const conversationId = await createConversation(session);
			await bump(session, conversationId);
			clock.now += 60_000;
			await session.commit(async () => {}, context);
			await settleLine(session);
			// Not dropped at once, as a retention of 0 would: the ten-minute default holds it.
			expect(sizes().cached).toBe(1);
			await session.close(context);
		}
		const { session, clock, sizes } = open(Number.POSITIVE_INFINITY);
		const conversationId = await createConversation(session);
		await bump(session, conversationId);
		clock.now += 1e15;
		await session.commit(async () => {}, context);
		await settleLine(session);
		expect(sizes().cached).toBe(1);
		await session.close(context);
	});

	it("keeps no timer where timers cannot be unreferenced, and evicts on commits", async () => {
		const setTimer = globalThis.setTimeout;
		let timers = 0;
		globalThis.setTimeout = ((callback: () => void, ms?: number) => {
			timers++;
			const timer = setTimer(callback, ms);
			// As in Cloudflare Workers: a plain number, no `unref`.
			return Number(timer as unknown as number) as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			const { session, clock, sizes } = open(1_000);
			const conversationId = await createConversation(session);
			await bump(session, conversationId);
			await bump(session, conversationId);
			// Tried once, then never again.
			expect(timers).toBeLessThanOrEqual(1);
			clock.now += 10_000;
			await session.commit(async () => {}, context);
			await settleLine(session);
			expect(sizes().cached).toBe(0);
			await session.close(context);
		} finally {
			globalThis.setTimeout = setTimer;
		}
	});

	it("follows a Harness settings change at the next use", async () => {
		setDefaultDocumentRetention(600_000);
		onTestFinished(() => setDefaultDocumentRetention(defaultForRun));
		const setup = chatSetup();
		const settings: { -readonly [K in keyof HarnessSettings]: HarnessSettings[K] } = setup.settings;
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.commit(async (tx) => {
			(await tx.doc(TestDoc, root.id)).count++;
		}, context);
		const sizesOf = () => (harness as unknown as SessionImpl).documentCacheSizes;
		expect(sizesOf().cached).toBeGreaterThan(0);
		settings.documentRetentionMs = 0;
		await harness.snapshot(TestDoc, root.id, context);
		await eventually(async () => {
			await (harness as unknown as SessionImpl).readOnLine(async () => {});
			return sizesOf().cached === 0;
		});
		await harness.close(context);
	});

	it("gives the same views with documents evicted right after use as with documents kept", async () => {
		const run = async (documentRetentionMs: number): Promise<string[]> => {
			const setup = chatSetup();
			setup.settings.documentRetentionMs = documentRetentionMs;
			setup.settings.progress = { outputIntervalMs: 0 };
			addTool(
				setup.registry,
				defineTool({
					name: "steps",
					description: "Streams three steps",
					parameters: Type.Object({}),
					execute: async (_args, api) => {
						for (const step of ["a\n", "b\n", "c\n"]) {
							api.output(step);
							await new Promise((resolve) => setTimeout(resolve, 5));
						}
						return {};
					},
				}),
			);
			setup.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("steps", {}, { id: "s1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("done")]),
			]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			const history = await viewHistory(harness, root.id);
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			await harness.waitForIdle(context);
			history.detach();
			await harness.close(context);
			// Ids and times differ between runs; the sequence of entries, run states, and tool outputs must not.
			return history.views.map((view) => {
				const live = (view.docs["pi.live"] ?? {}) as LiveState;
				const tools = (live.tools ?? []).map((slot) => `${slot.callId}:${slot.status}:${slot.output ?? ""}`);
				const kinds = view.entries.map((entry) => entry.kind).join(",");
				return `${kinds} run:${live.run !== undefined} generation:${live.generation !== undefined} ${tools.join(" ")}`;
			});
		};
		expect(await run(0)).toEqual(await run(600_000));
	});

	it("keeps a reloaded newer version cached while an observer of the older one is attached", async () => {
		const V1 = defineDoc<Counter>({
			checkpointWhen: () => false,
			kind: "test.retention.versioned",
			version: 1,
			scope: "session",
			initial: () => ({ count: 3 }),
		});
		const V2 = defineDoc<Counter & { v2: true }>({
			checkpointWhen: () => false,
			kind: "test.retention.versioned",
			version: 2,
			scope: "session",
			initial: () => ({ count: 0, v2: true }),
			migrate: (value) => ({ count: (value as Counter).count, v2: true }),
		});
		const { session, sizes } = open(0);
		await session.commit((tx) => tx.doc(V1).then(() => undefined), context);
		const watch = (await session.watchDoc(V1, context))!;
		expect(await session.snapshot(V2, context)).toEqual({ count: 3, v2: true });
		await settleLine(session);
		expect(sizes().cached).toBe(1);
		await watch.stop();
		await eventually(async () => {
			await settleLine(session);
			return sizes().cached === 0;
		});
		await session.close(context);
	});

	it("queues one sweep job, not one per document, while a commit holds the line", async () => {
		const { session } = open(0);
		const conversationIds: ConversationId[] = [];
		for (let n = 0; n < 50; n++) {
			const id = await createConversation(session);
			await bump(session, id);
			conversationIds.push(id);
		}
		await eventually(async () => {
			await settleLine(session);
			return session.documentCacheSizes.cached === 0;
		});
		const before = session.documentCacheSizes.sweeps;
		// One commit loads 50 evicted documents from storage, each touched as it loads; the sweep job stays pending while
		// the line is held.
		await session.commit(async (tx) => {
			for (const id of conversationIds) {
				(await tx.doc(CounterDoc, id)).count++;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}, context);
		await settleLine(session);
		expect(session.documentCacheSizes.cached).toBe(0);
		expect(session.documentCacheSizes.sweeps - before).toBeLessThanOrEqual(2);
		await session.close(context);
	});
});
