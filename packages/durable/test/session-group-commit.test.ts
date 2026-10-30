// Group commit on the Session line (docs/group-commit.md): batching, gates, outcome fences, publication, failures per
// part, upkeep through the writer, backpressure, bounds, and a randomized interleaving against an oracle.
import type { Context } from "@earendil-works/chord";
import {
	type CommitOptions,
	type CommitResult,
	type ConversationId,
	defineDoc,
	type EntryId,
	type Seq,
	SessionFailed,
	type StorageWrite,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { CachedStorage } from "../src/session/cached-storage.ts";
import type { ObservedCommit } from "../src/session/session.ts";
import { SessionImpl } from "../src/session/session.ts";
import { Transaction } from "../src/session/transaction.ts";
import { ControlledStorage, context, flush, refusingAt } from "./session-support.ts";
import { type Deferred, deferred, eventually, settled } from "./task-support.ts";

/** A latest, initial-fork conversation document: one key per conversation, and one a deferred commit may hold. */
const Note = defineDoc<{ n: number }>({
	checkpointWhen: () => false,
	kind: "gc.note",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ n: 0 }),
});

const Shared = defineDoc<{ n: number }>({
	checkpointWhen: () => false,
	kind: "gc.shared",
	version: 1,
	scope: "session",
	initial: () => ({ n: 0 }),
});

const DEFERRED = { persistence: { kind: "deferred", withinMs: Number.POSITIVE_INFINITY } } as const;

/**
 * Memory storage whose `commit()` calls are recorded and can be held in flight, and whose batches can be refused
 * (failed before adoption) or whose calls can reject after their receipts.
 */
class BatchStorage extends ControlledStorage {
	readonly calls: (readonly (readonly StorageWrite[])[])[] = [];
	/** Refuse the next batch this matches, with `refusal.value`. */
	refuse: ((writes: readonly StorageWrite[]) => boolean) | undefined;
	refusal: { readonly value: unknown } = { value: new Error("refused") };
	/** Reject the call with this index after its batches are stored, with `rejection.value`. */
	rejectCall: number | undefined;
	rejection: { readonly value: unknown } = { value: new Error("connection lost") };
	/** Delay each call by up to this many milliseconds, at random. */
	latency: (() => number) | undefined;
	#held: { readonly entered: Deferred; readonly gate: Deferred } | undefined;

	/** Hold the next call in flight until released. */
	hold(): { readonly entered: Promise<void>; release(): void } {
		const held = { entered: deferred(), gate: deferred() };
		this.#held = held;
		return { entered: held.entered.promise, release: () => held.gate.resolve() };
	}

	override async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		commitContext: Context,
	): Promise<CommitResult> {
		const call = this.calls.length;
		this.calls.push(batches);
		const held = this.#held;
		this.#held = undefined;
		if (held !== undefined) {
			held.entered.resolve();
			await held.gate.promise;
		}
		const delay = this.latency?.();
		if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
		const refuses = (writes: readonly StorageWrite[]): boolean => {
			if (this.refuse?.(writes) !== true) return false;
			this.refuse = undefined;
			return true;
		};
		const result = await refusingAt(
			(...args) => super.commit(...args),
			batches,
			receive,
			commitContext,
			refuses,
			this.refusal.value,
		);
		if (this.rejectCall === call) throw this.rejection.value;
		return result;
	}
}

async function open(conversations: number): Promise<{
	readonly storage: BatchStorage;
	readonly session: SessionImpl;
	readonly ids: ConversationId[];
	readonly published: ObservedCommit[];
}> {
	const storage = new BatchStorage();
	const session = new SessionImpl(storage, Date.now, () => 600_000);
	const ids = await session.commit(async (tx) => {
		const created: ConversationId[] = [];
		for (let n = 0; n < conversations; n++) {
			created.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
		}
		return created;
	}, context);
	const published: ObservedCommit[] = [];
	session.followCommits((publication) => {
		published.push(publication);
	});
	return { storage, session, ids, published };
}

/** Increment conversation `id`'s note; resolves with the value it read. */
function bump(session: SessionImpl, id: ConversationId, options?: CommitOptions): Promise<number> {
	return session.commit(
		async (tx) => {
			const note = await tx.doc(Note, id);
			return note.n++;
		},
		context,
		options,
	);
}

/** Record the order in which `promises` settle, by name; a rejection as `name!`. */
function settleOrder(promises: Record<string, Promise<unknown>>): string[] {
	const order: string[] = [];
	for (const [name, promise] of Object.entries(promises)) {
		promise.then(
			() => order.push(name),
			() => order.push(`${name}!`),
		);
	}
	return order;
}

/** The note values a reopened Session over `storage` reads, per conversation. */
async function notes(storage: BatchStorage, ids: readonly ConversationId[]): Promise<number[]> {
	const reopened = new SessionImpl(storage.reopen());
	const values: number[] = [];
	for (const id of ids) values.push((await reopened.snapshot(Note, id, context))?.n ?? 0);
	await reopened.close(context);
	return values;
}

/** The kinds of the entries `published` holds, in order. */
function entryKinds(published: readonly ObservedCommit[]): string[] {
	return published.flatMap((publication) =>
		publication.kind === "stored"
			? publication.changes.flatMap((change) => (change.type === "entry" ? [change.value.kind] : []))
			: [],
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("group commit: batching", () => {
	it("stores the commits admitted while a call is in flight in one call, each with its seq, published in order", async () => {
		const { storage, session, ids, published } = await open(3);
		const [a, b, c] = ids as [ConversationId, ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const ran: string[] = [];
		const second = session.commit(async (tx) => {
			(await tx.doc(Note, b)).n++;
			ran.push("b");
		}, context);
		const third = session.commit(async (tx) => {
			(await tx.doc(Note, c)).n++;
			ran.push("c");
		}, context);
		// Their callbacks run while the first commit is in flight: they touch nothing it writes.
		await eventually(() => ran.length === 2);
		expect(published).toHaveLength(0);
		const order = settleOrder({ a: first, b: second, c: third });
		held.release();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["a", "b", "c"]);
		expect(storage.calls.slice(-2).map((call) => call.length)).toEqual([1, 2]);
		const seqs = published.map((publication) => (publication.kind === "stored" ? publication.seq : 0));
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(new Set(seqs).size).toBe(3);
		await session.close(context);
	});
});

describe("group commit: gates", () => {
	it("makes a read of an entry ID leaked by an unpublished commit wait for its publication", async () => {
		const { storage, session, ids } = await open(1);
		const held = storage.hold();
		let leaked: EntryId | undefined;
		const appending = session.commit(async (tx) => {
			leaked = (await tx.appendEntry(ids[0]!, { kind: "note" })).id;
		}, context);
		await held.entered;
		const reading = session.commit((tx) => tx.entry(leaked!), context);
		expect(await settled(reading)).toBe(false);
		held.release();
		await appending;
		expect((await reading)?.id).toBe(leaked);
		await session.close(context);
	});

	it("makes a job wait for an unpublished creation at a document address instead of creating it again", async () => {
		const { storage, session } = await open(0);
		const held = storage.hold();
		const first = session.commit(async (tx) => {
			(await tx.doc(Shared)).n++;
		}, context);
		await held.entered;
		const second = session.commit(async (tx) => {
			const shared = await tx.doc(Shared);
			shared.n++;
			return shared.n;
		}, context);
		expect(await settled(second)).toBe(false);
		held.release();
		await first;
		expect(await second).toBe(2);
		const creations = storage.calls
			.flat(2)
			.filter((write) => write.type === "document.create" && write.record.kind === Shared.definition.kind);
		expect(creations).toHaveLength(1);
		await session.close(context);
	});

	it("makes a write to a conversation an unpublished commit creates wait for it", async () => {
		const { storage, session } = await open(0);
		const held = storage.hold();
		let leaked: ConversationId | undefined;
		const creating = session.commit(async (tx) => {
			leaked = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
		}, context);
		await held.entered;
		const appending = session.commit((tx) => tx.appendEntry(leaked!, { kind: "note" }), context);
		expect(await settled(appending)).toBe(false);
		held.release();
		await creating;
		expect((await appending).conversationId).toBe(leaked);
		await session.close(context);
	});

	it("makes each read of the entries of a conversation an unpublished commit creates wait for its creation", async () => {
		// The Session's own helpers (newest entry, head marker), a transaction's scan, and the line's reads, each alone
		// behind the creation, of a conversation Storage does not have yet.
		const reads: Record<string, (session: SessionImpl, id: ConversationId) => Promise<unknown>> = {
			latestEntryId: (session, id) => session.commit((tx) => tx.latestEntryId(id), context),
			latestHeadMarker: (session, id) => session.commit((tx) => tx.latestHeadMarker(id), context),
			"tx.scanEntries": (session, id) =>
				session.commit(async (tx) => (await tx.scanEntries({ conversationId: id }, 1)).items, context),
			"line scanEntries": (session, id) =>
				session.readOnLine(
					async (line) => (await line.scanEntries({ conversationId: id }, 1, undefined, context)).items,
				),
			"line findLatestHeadMarker": (session, id) =>
				session.readOnLine((line) => line.findLatestHeadMarker(id, undefined, context)),
		};
		for (const [name, read] of Object.entries(reads)) {
			const { storage, session } = await open(0);
			const held = storage.hold();
			let leaked: ConversationId | undefined;
			const creating = session.commit(async (tx) => {
				leaked = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
			}, context);
			await held.entered;
			const reading = read(session, leaked!);
			await flush();
			held.release();
			await creating;
			const result = await reading.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			expect(result, name).toEqual({ value: Array.isArray((result as { value?: unknown }).value) ? [] : undefined });
			await session.close(context);
		}
	});

	it("makes a scan that cannot be keyed wait for every unpublished commit", async () => {
		const { storage, session } = await open(0);
		const held = storage.hold();
		const creating = session.commit(
			async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
			context,
		);
		await held.entered;
		const scanning = session.commit(
			async (tx) => (await tx.scanConversations({}, 10)).items.map((c) => c.id),
			context,
		);
		expect(await settled(scanning)).toBe(false);
		held.release();
		expect(await scanning).toContain(await creating);
		await session.close(context);
	});

	it("makes a line read after an un-awaited commit see it", async () => {
		const { storage, session, ids } = await open(1);
		const held = storage.hold();
		let leaked: EntryId | undefined;
		void session.commit(async (tx) => {
			leaked = (await tx.appendEntry(ids[0]!, { kind: "note" })).id;
		}, context);
		await held.entered;
		const reading = session.readOnLine((storage) => storage.entry(leaked!, context));
		await flush();
		held.release();
		expect((await reading)?.entry.id).toBe(leaked);
		await session.close(context);
	});

	it("makes a reader of a document whose held changes an unpublished commit stores wait, and store them once", async () => {
		const { storage, session, ids } = await open(1);
		const id = ids[0]!;
		await bump(session, id);
		await bump(session, id, DEFERRED);
		// The first commit only reads the held document: storing its held changes is its write of it.
		const held = storage.hold();
		const storing = session.commit(async (tx) => {
			await tx.doc(Note, id);
			await tx.appendEntry(id, { kind: "a" });
		}, context);
		await held.entered;
		let read = false;
		const reading = session.commit(async (tx) => {
			await tx.doc(Note, id);
			read = true;
			await tx.appendEntry(id, { kind: "b" });
		}, context);
		await flush();
		expect(read).toBe(false);
		held.release();
		await Promise.all([storing, reading]);
		const changes = storage.calls
			.slice(-2)
			.map((call) => call.flat().filter((write) => write.type === "document.change"));
		expect(changes.map((writes) => writes.length)).toEqual([1, 0]);
		const record = (await storage.findDocument(
			{ kind: Note.definition.kind, scope: { kind: "conversation", conversationId: id } },
			"current",
			context,
		))!;
		expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(1);
		await session.close(context);
	});

	it("makes a reader of a document held by a deferred commit behind a call wait for it, and store it", async () => {
		const { storage, session, ids, published } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		await bump(session, a);
		const held = storage.hold();
		const first = bump(session, b);
		await held.entered;
		const deferredCommit = session.commit(
			async (tx) => {
				(await tx.doc(Note, a)).n = 5;
			},
			context,
			DEFERRED,
		);
		const reader = bump(session, a);
		await flush();
		// Nothing is published while the first commit is in flight, the deferred one neither.
		expect(published).toHaveLength(1);
		held.release();
		await Promise.all([first, deferredCommit]);
		expect(await reader).toBe(5);
		// The reader's own batch stored what the deferred commit held.
		const stored = storage.calls.at(-1)!.flat();
		expect(stored.filter((write) => write.type === "document.change")).toHaveLength(1);
		await session.close(context);
		expect(await notes(storage, [a, b])).toEqual([6, 1]);
	});
});

describe("group commit: outcomes", () => {
	it("delivers a read, a commit without writes, a callback error, and a deferred commit after an earlier commit", async () => {
		const { storage, session, ids } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const order = settleOrder({
			first,
			read: session.readOnLine(async () => "read"),
			none: session.commit(async () => "none", context),
			error: session.commit(async () => {
				throw new Error("own");
			}, context),
			deferred: bump(session, b, DEFERRED),
		});
		await flush();
		expect(order).toEqual([]);
		held.release();
		await eventually(() => order.length === 5);
		// A callback's own error affects only its job.
		expect(order).toEqual(["first", "read", "none", "error!", "deferred"]);
		await session.close(context);
	});

	it("makes every outcome after a fatal failure SessionFailed, and keeps the earlier ones", async () => {
		const { storage, session, ids } = await open(4);
		const [a, b, c, d] = ids as [ConversationId, ConversationId, ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const stored = bump(session, b);
		const refused = session.commit((tx) => tx.appendEntry(c, { kind: "refuse" }), context);
		const after = bump(session, d);
		const read = session.readOnLine(async () => "read");
		storage.refuse = (writes) => writes.some((write) => write.type === "entry" && write.value.kind === "refuse");
		// Every callback has run, so the three are admitted while the first call is in flight.
		await flush();
		held.release();
		expect(await first).toBe(0);
		expect(await stored).toBe(0);
		await expect(refused).rejects.toThrow("refused");
		await expect(after).rejects.toBeInstanceOf(SessionFailed);
		await expect(read).rejects.toBeInstanceOf(SessionFailed);
		expect(await session.closed).toEqual({ kind: "failed", error: new Error("refused") });
		// One call stored the first two of the three batches it got; the refused one and the one after it are not stored.
		expect(storage.calls.at(-1)).toHaveLength(3);
		expect(await notes(storage, [a, b, d])).toEqual([1, 1, 0]);
	});
});

describe("group commit: failures per part", () => {
	it("publishes the parts received before a call rejects, then rejects them with its error", async () => {
		const { storage, session, ids, published } = await open(3);
		const [a, b, c] = ids as [ConversationId, ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const second = bump(session, b);
		const third = bump(session, c);
		storage.rejectCall = storage.calls.length;
		await flush();
		held.release();
		await first;
		await expect(second).rejects.toThrow("connection lost");
		await expect(third).rejects.toThrow("connection lost");
		// Durable, so published.
		expect(published).toHaveLength(3);
		expect(await session.closed).toEqual({ kind: "failed", error: new Error("connection lost") });
		expect(await notes(storage, [a, b, c])).toEqual([1, 1, 1]);
	});

	it("fails every job after the first part of a call that rejects, except its other parts, with their storage error", async () => {
		const { storage, session, ids, published } = await open(1);
		const id = ids[0]!;
		const held = storage.hold();
		const first = session.commit((tx) => tx.appendEntry(id, { kind: "a" }), context);
		await held.entered;
		// Between the two parts of the failing call, a job without writes.
		const before = session.commit((tx) => tx.appendEntry(id, { kind: "b" }), context);
		const between = session.commit(async () => "no write", context);
		const after = session.commit((tx) => tx.appendEntry(id, { kind: "d" }), context);
		const outcomes = Promise.allSettled([first, before, between, after]);
		await flush();
		storage.rejectCall = storage.calls.length;
		held.release();
		const [a, b, n, d] = await outcomes;
		expect(a.status).toBe("fulfilled");
		expect(b).toMatchObject({ status: "rejected", reason: new Error("connection lost") });
		expect((n as PromiseRejectedResult).reason).toBeInstanceOf(SessionFailed);
		expect(d).toMatchObject({ status: "rejected", reason: new Error("connection lost") });
		// Both parts were received, so they were published before they rejected.
		expect(storage.calls.at(-1)).toHaveLength(2);
		expect(published).toHaveLength(3);
		expect(await session.closed).toEqual({ kind: "failed", error: new Error("connection lost") });
	});

	it("reports SessionFailed with the first error for a call that rejects after another failure failed the Session", async () => {
		const { storage, session, ids, published } = await open(1);
		const id = ids[0]!;
		const held = storage.hold();
		const inFlight = session.commit((tx) => tx.appendEntry(id, { kind: "a" }), context);
		await held.entered;
		// A later job's read fails first, and fails the Session; then the call in flight rejects with another error.
		const first = new Error("first failure: read");
		vi.spyOn(storage, "task").mockRejectedValueOnce(first);
		const reading = session.commit((tx) => tx.task(idFromNumber<TaskId>(999)), context);
		reading.catch(() => {});
		await flush();
		expect(session.failure).toEqual({ error: first });
		storage.rejectCall = storage.calls.length - 1;
		held.release();
		await expect(reading).rejects.toBe(first);
		const outcome = await inFlight.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).toBeInstanceOf(SessionFailed);
		expect((outcome as SessionFailed).cause).toBe(first);
		// Nothing of the call is published once the Session failed.
		expect(published).toEqual([]);
		expect(await session.closed).toEqual({ kind: "failed", error: first });
	});

	for (const value of [undefined, null]) {
		it(`rejects every part of a call with its rejection value, ${value} included`, async () => {
			const { storage, session, ids } = await open(3);
			const [a, b, c] = ids as [ConversationId, ConversationId, ConversationId];
			const held = storage.hold();
			const first = bump(session, a);
			await held.entered;
			const settle = (promise: Promise<unknown>) =>
				promise.then(
					() => ({ kind: "resolved" }),
					(error: unknown) => ({ kind: "rejected", error }),
				);
			const parts = [settle(bump(session, b)), settle(bump(session, c))];
			await flush();
			storage.rejection = { value };
			storage.rejectCall = storage.calls.length;
			held.release();
			await first;
			expect(await Promise.all(parts)).toEqual([
				{ kind: "rejected", error: value },
				{ kind: "rejected", error: value },
			]);
			expect(await session.closed).toEqual({ kind: "failed", error: value });
		});

		it(`rejects a refused part with its refusal, ${value} included, and the parts after it with SessionFailed`, async () => {
			const { storage, session, ids } = await open(3);
			const [a, b, c] = ids as [ConversationId, ConversationId, ConversationId];
			const held = storage.hold();
			const first = bump(session, a);
			await held.entered;
			const refused = session
				.commit((tx) => tx.appendEntry(b, { kind: "refuse" }), context)
				.then(
					() => ({ kind: "resolved" }),
					(error: unknown) => ({ kind: "rejected", error }),
				);
			const after = bump(session, c).then(
				() => undefined,
				(error: unknown) => error,
			);
			await flush();
			storage.refusal = { value };
			storage.refuse = (writes) => writes.some((write) => write.type === "entry" && write.value.kind === "refuse");
			held.release();
			await first;
			expect(await refused).toEqual({ kind: "rejected", error: value });
			expect(await after).toBeInstanceOf(SessionFailed);
			expect(await session.closed).toEqual({ kind: "failed", error: value });
		});
	}

	it("leaves the parts after one whose adoption throws unpublished, rejected with SessionFailed", async () => {
		const { storage, session, ids, published } = await open(4);
		const [a, b, c, d] = ids as [ConversationId, ConversationId, ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const before = bump(session, b);
		const failing = bump(session, c);
		const after = bump(session, d);
		const failure = new Error("adoption failed");
		const adopt = Transaction.prototype.adopt;
		let adoptions = 0;
		vi.spyOn(Transaction.prototype, "adopt").mockImplementation(function (this: Transaction, seq: Seq) {
			if (++adoptions === 3) throw failure;
			return adopt.call(this, seq);
		});
		await flush();
		held.release();
		await first;
		await before;
		await expect(failing).rejects.toBe(failure);
		await expect(after).rejects.toBeInstanceOf(SessionFailed);
		expect(published).toHaveLength(2);
		expect(await session.closed).toEqual({ kind: "failed", error: failure });
		// All four are durable: reopening recovers the unpublished one.
		vi.restoreAllMocks();
		expect(await notes(storage, [a, b, c, d])).toEqual([1, 1, 1, 1]);
	});
});

describe("group commit: a publication that throws", () => {
	it("fails the Session for a deferred commit memory cannot adopt, and still closes", async () => {
		const { session, ids, published } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		await bump(session, a);
		await bump(session, b);
		published.length = 0;
		const failure = new Error("held adoption failed");
		vi.spyOn(Transaction.prototype, "adoptHeld").mockImplementationOnce(() => {
			throw failure;
		});
		const held = bump(session, a, DEFERRED);
		const after = bump(session, b);
		await expect(held).rejects.toBe(failure);
		await expect(after).rejects.toBeInstanceOf(SessionFailed);
		expect(published).toEqual([]);
		expect(await session.closed).toEqual({ kind: "failed", error: failure });
		await session.close(context);
	});

	it("settles a deferred commit whose adoption throws, alone, and closes", async () => {
		// Astra's: the only commit is the deferred one, on a storage that runs nothing else.
		const storage = new ControlledStorage();
		const session = new SessionImpl(storage);
		const id = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await tx.doc(Note, conversation.id);
			return conversation.id;
		}, context);
		const failure = new Error("injected held adoption failure");
		vi.spyOn(Transaction.prototype, "adoptHeld").mockImplementationOnce(() => {
			throw failure;
		});
		await expect(bump(session, id, DEFERRED)).rejects.toBe(failure);
		expect(session.failure).toEqual({ error: failure });
		await session.close(context);
		expect(await session.closed).toEqual({ kind: "failed", error: failure });
		expect(session.lineSizes).toEqual({ outstanding: 0, unpublished: 0, reads: 0 });
	});

	it("fails the Session for a throw in the read caches' write-through, and leaves the later parts unpublished", async () => {
		const { storage, session, ids, published } = await open(3);
		const [a, b, c] = ids as [ConversationId, ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const failing = bump(session, b);
		const after = bump(session, c);
		await flush();
		const failure = new Error("cache write failed");
		const write = CachedStorage.prototype.published;
		let writes = 0;
		vi.spyOn(CachedStorage.prototype, "published").mockImplementation(function (this: CachedStorage, batch) {
			if (++writes === 2) throw failure;
			return write.call(this, batch);
		});
		held.release();
		await first;
		await expect(failing).rejects.toBe(failure);
		await expect(after).rejects.toBeInstanceOf(SessionFailed);
		expect(published).toHaveLength(1);
		expect(await session.closed).toEqual({ kind: "failed", error: failure });
		await session.close(context);
	});
});

describe("group commit: deferred commits", () => {
	it("publishes a deferred commit only once the commit before it is published", async () => {
		const { storage, session, ids, published } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		// Only a change of an existing document is held.
		await bump(session, b);
		published.length = 0;
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const later = bump(session, b, DEFERRED);
		await flush();
		expect(published).toHaveLength(0);
		held.release();
		await Promise.all([first, later]);
		expect(published.map((publication) => publication.kind)).toEqual(["stored", "memory"]);
		await session.close(context);
	});

	it("never publishes a deferred commit behind a commit that fails", async () => {
		const { storage, session, ids, published } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		await bump(session, b);
		published.length = 0;
		const held = storage.hold();
		const first = session.commit((tx) => tx.appendEntry(a, { kind: "refuse" }), context);
		await held.entered;
		const later = bump(session, b, DEFERRED);
		storage.refuse = (writes) => writes.some((write) => write.type === "entry" && write.value.kind === "refuse");
		held.release();
		await expect(first).rejects.toThrow("refused");
		await expect(later).rejects.toBeInstanceOf(SessionFailed);
		expect(published).toEqual([]);
	});
});

describe("group commit: publication", () => {
	it("publishes the parts of one call a macrotask apart: what one resolves runs before the next is published", async () => {
		const { storage, session, ids, published } = await open(3);
		const [a, b, c] = ids as [ConversationId, ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const second = bump(session, b);
		const third = bump(session, c);
		let seenAtSecond: number | undefined;
		void second.then(() => {
			seenAtSecond = published.length;
		});
		await flush();
		held.release();
		await Promise.all([first, second, third]);
		expect(storage.calls.at(-1)).toHaveLength(2);
		expect(seenAtSecond).toBe(2);
		expect(published).toHaveLength(3);
		await session.close(context);
	});
});

describe("group commit: the storage's publication scope", () => {
	it("publishes each commit inside the storage's scope, the next only once one it runs later ran", async () => {
		const { storage, session, ids, published } = await open(3);
		const [a, b, c] = ids as [ConversationId, ConversationId, ConversationId];
		const scopes: string[] = [];
		let depth = 0;
		// Runs each publication a macrotask later, inside a scope of its own.
		(storage as { publishing?: (publish: () => void, context: Context) => void }).publishing = (publish) => {
			setTimeout(() => {
				depth++;
				scopes.push(`open ${published.length}`);
				publish();
				scopes.push(`close ${published.length}`);
				depth--;
			}, 0);
		};
		let inside: boolean[] = [];
		session.followCommits(() => {
			inside.push(depth === 1);
		});
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const rest = [bump(session, b), bump(session, c)];
		await flush();
		inside = [];
		held.release();
		await Promise.all([first, ...rest]);
		expect(inside).toEqual([true, true, true]);
		expect(scopes).toEqual(["open 0", "close 1", "open 1", "close 2", "open 2", "close 3"]);
		await session.close(context);
	});

	it("reports a scope that throws instead of running the publication, and publishes the commit", async () => {
		const { storage, session, ids, published } = await open(1);
		const reports: unknown[] = [];
		session.report = (error) => {
			reports.push(error);
		};
		(storage as { publishing?: (publish: () => void, context: Context) => void }).publishing = () => {
			throw new Error("no scope");
		};
		expect(await bump(session, ids[0]!)).toBe(0);
		expect(published).toHaveLength(1);
		expect(reports).toEqual([new Error("no scope")]);
		await session.close(context);
	});
});

describe("group commit: a failure between two publications", () => {
	it("publishes no part of a call after a failure that a continuation of an earlier part caused", async () => {
		const { storage, session, ids, published } = await open(1);
		const id = ids[0]!;
		const held = storage.hold();
		const lead = session.commit((tx) => tx.appendEntry(id, { kind: "lead" }), context);
		await held.entered;
		const one = session.commit((tx) => tx.appendEntry(id, { kind: "one" }), context);
		const two = session.commit((tx) => tx.appendEntry(id, { kind: "two" }), context);
		two.catch(() => {});
		// What `one` resolves runs in the hop before `two` is published: a read there fails the Session.
		const read = new Error("read failed between publications");
		vi.spyOn(storage, "task").mockRejectedValue(read);
		const failing = one.then(() => session.commit((tx) => tx.task(idFromNumber<TaskId>(999)), context));
		failing.catch(() => {});
		await flush();
		held.release();
		await Promise.allSettled([lead, one, two, failing]);
		expect(entryKinds(published)).toEqual(["lead", "one"]);
		const outcome = await two.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).toBeInstanceOf(SessionFailed);
		expect((outcome as SessionFailed).cause).toBe(read);
	});

	it("publishes no part of a call after the Session fails in a continuation of an earlier part", async () => {
		// Sol's: `one`'s continuation fails the Session itself.
		const { storage, session, ids, published } = await open(1);
		const id = ids[0]!;
		const held = storage.hold();
		const lead = session.commit((tx) => tx.appendEntry(id, { kind: "lead" }), context);
		await held.entered;
		const failure = new Error("failed between publications");
		const one = session.commit((tx) => tx.appendEntry(id, { kind: "one" }), context);
		void one.then(() => session.fail(failure));
		const two = session.commit((tx) => tx.appendEntry(id, { kind: "two" }), context);
		two.catch(() => {});
		await flush();
		held.release();
		await Promise.allSettled([lead, one, two]);
		expect(entryKinds(published)).toEqual(["lead", "one"]);
		await expect(two).rejects.toBeInstanceOf(SessionFailed);
	});

	it("checks the failure when a storage's scope runs a publication it deferred, not when it was asked to", async () => {
		const { storage, session, ids, published } = await open(1);
		const id = ids[0]!;
		const failure = new Error("failed before a deferred publication ran");
		let calls = 0;
		// The second publication's scope is entered before the failure; it runs the publication only after it.
		(storage as { publishing?: (publish: () => void, context: Context) => void }).publishing = (publish) => {
			if (++calls === 2) session.fail(failure);
			setTimeout(publish, 0);
		};
		const held = storage.hold();
		const lead = session.commit((tx) => tx.appendEntry(id, { kind: "lead" }), context);
		await held.entered;
		const one = session.commit((tx) => tx.appendEntry(id, { kind: "one" }), context);
		one.catch(() => {});
		await flush();
		held.release();
		await Promise.allSettled([lead, one]);
		expect(entryKinds(published)).toEqual(["lead"]);
		await expect(one).rejects.toBeInstanceOf(SessionFailed);
	});
});

describe("group commit: upkeep through the writer", () => {
	it("stores held changes for an unload after the call in flight", async () => {
		const { storage, session, ids } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		await bump(session, a);
		await bump(session, b, DEFERRED);
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const unloading = session.unloadDocuments();
		expect(await settled(unloading)).toBe(false);
		held.release();
		await Promise.all([first, unloading]);
		expect(storage.calls.at(-1)!.flat()).toMatchObject([{ type: "document.change" }]);
		expect(await session.snapshot(Note, b, context)).toEqual({ n: 1 });
		await session.close(context);
		expect(await notes(storage, [a, b])).toEqual([2, 1]);
	});

	it("stores held changes for a version reload inside a callback after the call in flight", async () => {
		const NoteV2 = defineDoc<{ n: number; migrated: true }>({
			checkpointWhen: () => false,
			kind: "gc.note",
			version: 2,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({ n: 0, migrated: true }),
			migrate: (value) => ({ ...(value as { n: number }), migrated: true }),
		});
		const { storage, session, ids } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		await bump(session, a);
		await bump(session, b);
		await bump(session, b, DEFERRED);
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const reloading = session.commit(async (tx) => (await tx.doc(NoteV2, b)).n, context);
		expect(await settled(reloading)).toBe(false);
		held.release();
		await first;
		// The reload found what memory held, stored first.
		expect(await reloading).toBe(2);
		await session.close(context);
	});

	it("stores held changes at their deadline after the call in flight", async () => {
		const { storage, session, ids } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		await bump(session, a);
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const later = bump(session, b, { persistence: { kind: "deferred", withinMs: 0 } });
		await flush();
		const calls = storage.calls.length;
		held.release();
		await Promise.all([first, later]);
		await eventually(() => storage.calls.length === calls + 1);
		expect(storage.calls.at(-1)!.flat()).toMatchObject([{ type: "document.create" }]);
		await session.close(context);
	});

	it("drains the calls in flight and stores held changes when it closes", async () => {
		const { storage, session, ids } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		const later = bump(session, b, DEFERRED);
		await flush();
		const closing = session.close(context);
		held.release();
		await Promise.all([first, later]);
		await closing;
		expect(await session.closed).toEqual({ kind: "closed" });
		expect(await notes(storage, [a, b])).toEqual([1, 1]);
	});
});

describe("group commit: backpressure and bounds", () => {
	it("starts no job past 256 without a delivered outcome, and returns its line state to zero when idle", async () => {
		const { storage, session, ids } = await open(2);
		const [a, b] = ids as [ConversationId, ConversationId];
		const held = storage.hold();
		const first = bump(session, a);
		await held.entered;
		let ran = 0;
		const appends: Promise<unknown>[] = [];
		for (let n = 0; n < 300; n++) {
			appends.push(
				session.commit(async (tx) => {
					ran++;
					await tx.appendEntry(b, { kind: "note" });
				}, context),
			);
		}
		await eventually(() => ran === 255);
		await flush();
		expect(ran).toBe(255);
		expect(session.lineSizes.outstanding).toBe(256);
		held.release();
		await Promise.all([first, ...appends]);
		expect(ran).toBe(300);
		expect(session.lineSizes).toEqual({ outstanding: 0, unpublished: 0, reads: 0 });
		await session.close(context);
	});
});

describe("group commit: randomized interleavings", () => {
	/** A small deterministic generator, so a failing seed reproduces. */
	function random(seed: number): () => number {
		let state = seed;
		return () => {
			state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
			return state / 2_147_483_648;
		};
	}

	for (const seed of [1, 7, 42, 1_234, 99_991]) {
		it(`stores, publishes, and reads only what an order of the commits implies (seed ${seed})`, async () => {
			const next = random(seed);
			const { storage, session, ids } = await open(4);
			const log = ids[0]!;
			storage.latency = () => Math.floor(next() * 3);
			const refuseAt = seed % 2 === 0 ? Math.floor(next() * 60) : -1;
			storage.refuse = (writes) =>
				writes.some(
					(write) => write.type === "entry" && (write.value.data as { index?: number })?.index === refuseAt,
				);
			// Per commit, in line order: the notes it increments and the values it read.
			const plans: ConversationId[][] = [];
			const reads: (number[] | undefined)[] = [];
			const outcomes: Promise<unknown>[] = [];
			for (let index = 0; index < 60; index++) {
				const touched = ids.filter(() => next() < 0.4);
				plans.push(touched);
				const outcome = session.commit(async (tx) => {
					const values: number[] = [];
					for (const id of touched) values.push((await tx.doc(Note, id)).n++);
					reads[index] = values;
					await tx.appendEntry(log, { kind: "log", data: { index } });
				}, context);
				outcome.catch(() => {});
				outcomes.push(outcome);
				const pause = next();
				if (pause < 0.3) await outcome.catch(() => {});
				else if (pause < 0.5) await flush();
			}
			const results = await Promise.allSettled(outcomes);
			if (refuseAt >= 0) await session.closed;
			else await session.close(context);
			// Outcomes match storage: a commit resolved exactly when its log entry is stored.
			const reopened = new SessionImpl(storage.reopen());
			const logged = new Set<number>();
			const entries = await reopened.commit((tx) => tx.scanEntries({ conversationId: log }, 1_000), context);
			for (const entry of entries.items) logged.add((entry.data as { index: number }).index);
			const stored = results.map((result) => result.status === "fulfilled");
			for (const [index, ok] of stored.entries()) expect(logged.has(index), `commit ${index}`).toBe(ok);
			// Each callback read every earlier stored increment of what it touched, and nothing else.
			for (const [index, values] of reads.entries()) {
				if (values === undefined) continue;
				for (const [position, id] of plans[index]!.entries()) {
					const expected = plans
						.slice(0, index)
						.filter((touched, earlier) => stored[earlier] && touched.includes(id));
					expect(values[position], `commit ${index} read of ${id}`).toBe(expected.length);
				}
			}
			// Storage equals the stored commits replayed in order.
			for (const id of ids) {
				const increments = plans.filter((touched, index) => stored[index] && touched.includes(id)).length;
				expect((await reopened.snapshot(Note, id, context))?.n ?? 0).toBe(increments);
			}
			expect(session.lineSizes).toEqual({ outstanding: 0, unpublished: 0, reads: 0 });
			await reopened.close(context);
		});
	}
});
