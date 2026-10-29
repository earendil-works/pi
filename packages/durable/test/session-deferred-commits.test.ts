// Deferred commits (`CommitPersistence`): what a deferred commit holds in memory, what stores it, and what Storage and
// each kind of listener then sees.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { JsonValue } from "@earendil-works/chord";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
	type CommitChange,
	type CommitOptions,
	type CommitPublication,
	type ConversationId,
	type DocumentId,
	defineDoc,
	type JsonObject,
	ReadOnlySession,
	type SetTimer,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type ObservedCommit, SessionImpl } from "../src/session/session.ts";
import { ControlledStorage, context, createConversation, flush, onValue } from "./session-support.ts";

type Text = { text: string; base?: boolean; explode?: boolean; keys?: Record<string, number> };

/** A latest, initial-fork conversation document, the kind a deferred commit may hold. */
const TextDoc = defineDoc<Text>({
	kind: "test.deferred.text",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ text: "" }),
	checkpointWhen: (value) => {
		if (value.explode === true) throw new Error("checkpoint failed");
		return value.base === true;
	},
});

/** `TextDoc` at version 2, which a reload migrates to. */
const TextDocV2 = defineDoc<Text & { migrated: true }>({
	kind: "test.deferred.text",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ text: "", migrated: true }),
	// `migrate()` gets the older version's untyped value: version 1's `Text`.
	migrate: (value) => ({ ...(value as Text), migrated: true }),
	checkpointWhen: () => false,
});

const RewindableDoc = defineDoc<Text>({
	kind: "test.deferred.rewindable",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
	checkpointWhen: () => false,
});

const CurrentForkDoc = defineDoc<Text>({
	kind: "test.deferred.current-fork",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ text: "" }),
	checkpointWhen: () => false,
});

const SessionTextDoc = defineDoc<Text>({
	kind: "test.deferred.session",
	version: 1,
	scope: "session",
	initial: () => ({ text: "" }),
	checkpointWhen: () => false,
});

/** Chord's `MAX_PENDING_OPS`: held operations past which a store writes the whole value. */
const MAX_PENDING_OPS = 10_000;

const DEFERRED: CommitOptions = { persistence: { kind: "deferred" } };

const IMMEDIATE: CommitOptions = { persistence: { kind: "immediate" } };

const within = (withinMs: number): CommitOptions => ({ persistence: { kind: "deferred", withinMs } });

/** One foreground timer the Session armed. */
type Armed = { readonly callback: () => void; readonly delayMs: number; disarmed: boolean; fired: boolean };

/**
 * A Session over controlled storage with a manual clock and manual foreground timers (background ones are declined, so
 * commits evict), recording what `observeCommits()` and the Session's own observers get.
 */
async function open(options: { readonly retentionMs?: number; readonly persistWithinMs?: number } = {}) {
	const clock = { now: 1_000 };
	const timers: Armed[] = [];
	const setTimer: SetTimer = (callback, delayMs, { background }) => {
		if (background) return undefined;
		const timer: Armed = { callback, delayMs, disarmed: false, fired: false };
		timers.push(timer);
		return () => {
			timer.disarmed = true;
		};
	};
	const storage = new ControlledStorage();
	const session = new SessionImpl(
		storage,
		() => clock.now,
		() => options.retentionMs ?? 600_000,
		setTimer,
		false,
		() => options.persistWithinMs,
	);
	const stored: CommitPublication[] = [];
	session.observeCommits({
		advance: (publication) => {
			stored.push(publication);
		},
		end: () => {},
	});
	const observed: ObservedCommit[] = [];
	session.followCommits((publication) => {
		observed.push(publication);
	});
	const conversationId = await createConversation(session);
	await session.commit(async (tx) => {
		await tx.doc(TextDoc, conversationId);
	}, context);
	const recordId = (await storage.findDocument(address(conversationId), "current", context))!.id;
	return {
		clock,
		storage,
		session,
		stored,
		observed,
		conversationId,
		recordId,
		/** Timers armed and neither disarmed nor fired. */
		armed: () => timers.filter((timer) => !timer.disarmed && !timer.fired),
		/** Fire every armed timer and let the line run what they queued. */
		async fire(): Promise<void> {
			for (const timer of timers) {
				if (timer.disarmed || timer.fired) continue;
				timer.fired = true;
				timer.callback();
			}
			await session.readOnLine(async () => {});
		},
		/** Batches admitted to Storage from here on. */
		mark(): () => (readonly StorageWrite[])[] {
			const from = storage.commits.length;
			return () => storage.commits.slice(from);
		},
		async storedText(id: DocumentId = recordId): Promise<JsonObject | undefined> {
			return (await storage.document(id, "current", context))?.value;
		},
		sizes: () => session.documentCacheSizes,
	};
}

function address(conversationId: ConversationId) {
	return { kind: TextDoc.definition.kind, scope: { kind: "conversation", conversationId } } as const;
}

function append(
	session: SessionImpl,
	conversationId: ConversationId,
	text: string,
	options: CommitOptions = DEFERRED,
): Promise<void> {
	return session.commit(
		async (tx) => {
			(await tx.doc(TextDoc, conversationId)).text += text;
		},
		context,
		options,
	);
}

function changesOf(
	batches: readonly (readonly StorageWrite[])[],
): Extract<StorageWrite, { type: "document.change" }>[] {
	return batches.flat().filter((write) => write.type === "document.change");
}

describe("holding a deferred commit", () => {
	it("adopts a commit that only changes an existing latest, initial-fork conversation document in memory, unstored", async () => {
		const { session, storage, stored, observed, conversationId, sizes, storedText } = await open();
		const admitted = storage.commits.length;
		const publications = stored.length;
		await append(session, conversationId, "a");
		await append(session, conversationId, "b");
		expect(storage.commits.length).toBe(admitted);
		expect(stored.length).toBe(publications);
		expect(await session.snapshot(TextDoc, conversationId, context)).toEqual({ text: "ab" });
		expect(await storedText()).toEqual({ text: "" });
		expect(sizes().held).toBe(1);
		expect(observed.slice(-2).map((publication) => publication.kind)).toEqual(["memory", "memory"]);
	});

	it("stores a deferred commit at once when it writes anything else", async () => {
		const { session, storage, conversationId, sizes } = await open();
		const stores = async (change: Parameters<SessionImpl["commit"]>[0]): Promise<boolean> => {
			const admitted = storage.commits.length;
			await session.commit(change, context, DEFERRED);
			return storage.commits.length > admitted;
		};
		// An entry next to the held document's change.
		expect(
			await stores(async (tx) => {
				(await tx.doc(TextDoc, conversationId)).text += "x";
				await tx.appendEntry(conversationId, { kind: "test.note" });
			}),
		).toBe(true);
		// Creation, then other document semantics.
		expect(await stores(async (tx) => void (await tx.doc(RewindableDoc, conversationId)))).toBe(true);
		expect(
			await stores(async (tx) => {
				(await tx.doc(RewindableDoc, conversationId)).text = "r";
			}),
		).toBe(true);
		expect(await stores(async (tx) => void (await tx.doc(CurrentForkDoc, conversationId)))).toBe(true);
		expect(
			await stores(async (tx) => {
				(await tx.doc(CurrentForkDoc, conversationId)).text = "c";
			}),
		).toBe(true);
		expect(await stores(async (tx) => void (await tx.doc(SessionTextDoc)))).toBe(true);
		expect(
			await stores(async (tx) => {
				(await tx.doc(SessionTextDoc)).text = "s";
			}),
		).toBe(true);
		// A held document next to an immediate one: the whole commit is stored.
		expect(
			await stores(async (tx) => {
				(await tx.doc(TextDoc, conversationId)).text += "y";
				(await tx.doc(SessionTextDoc)).text += "s";
			}),
		).toBe(true);
		// Retirement.
		expect(await stores((tx) => tx.retireDoc(CurrentForkDoc, conversationId))).toBe(true);
		expect(sizes().held).toBe(0);
		// The control: the same change alone is held.
		expect(
			await stores(async (tx) => {
				(await tx.doc(TextDoc, conversationId)).text += "z";
			}),
		).toBe(false);
	});

	it("stores a deferred commit that migrates its document at once, as a base", async () => {
		const { session, conversationId, mark, sizes } = await open();
		const batches = mark();
		await session.commit(
			async (tx) => {
				(await tx.doc(TextDocV2, conversationId)).text = "v2";
			},
			context,
			DEFERRED,
		);
		expect(changesOf(batches()).map((write) => write.content.kind)).toEqual(["base"]);
		expect(sizes().held).toBe(0);
	});

	it("rejects a deferred commit on a read-only Session like any commit with writes", async () => {
		const { storage, conversationId } = await open();
		const viewer = new SessionImpl(storage, Date.now, () => 600_000, undefined, true);
		await expect(append(viewer, conversationId, "a")).rejects.toBeInstanceOf(ReadOnlySession);
	});

	it("rejects a withinMs that is not a number of milliseconds, 0 or more", async () => {
		const { session, conversationId } = await open();
		await expect(append(session, conversationId, "a", within(-1))).rejects.toBeInstanceOf(TypeError);
		await expect(append(session, conversationId, "a", within(Number.NaN))).rejects.toBeInstanceOf(TypeError);
		await expect(append(session, conversationId, "a", { persistence: { kind: "immediate" } })).resolves.toBe(
			undefined,
		);
	});
});

describe("storing held changes", () => {
	it("stores them first, folded with its own, in a commit that writes the document", async () => {
		const { session, conversationId, mark, sizes, storedText } = await open();
		await append(session, conversationId, "a");
		await append(session, conversationId, "b");
		const batches = mark();
		await append(session, conversationId, "c", IMMEDIATE);
		expect(batches()).toHaveLength(1);
		expect(changesOf(batches()).map((write) => write.content)).toEqual([
			{ version: 1, kind: "delta", ops: [["a", ["text"], "abc"]] },
		]);
		expect(await storedText()).toEqual({ text: "abc" });
		expect(sizes().held).toBe(0);
	});

	it("stores them in a commit that only reads the document, with its other writes", async () => {
		const { session, conversationId, mark, storedText } = await open();
		await append(session, conversationId, "held");
		const batches = mark();
		await session.commit(async (tx) => {
			const text = (await tx.doc(TextDoc, conversationId)).text;
			await tx.appendEntry(conversationId, { kind: "test.derived", data: text });
		}, context);
		expect(batches()).toHaveLength(1);
		expect(
			batches()[0]!
				.map((write) => write.type)
				.sort(),
		).toEqual(["document.change", "entry"]);
		expect(await storedText()).toEqual({ text: "held" });
	});

	it("leaves them held through commits that neither read nor write the document, or write nothing", async () => {
		const { session, conversationId, mark, sizes } = await open();
		await append(session, conversationId, "held");
		const batches = mark();
		await session.commit((tx) => tx.appendEntry(conversationId, { kind: "test.unrelated" }).then(() => {}), context);
		await session.commit(async (tx) => void (await tx.doc(TextDoc, conversationId)), context);
		expect(changesOf(batches())).toEqual([]);
		expect(sizes().held).toBe(1);
	});

	it("keeps them when a commit that reads the document fails before Storage", async () => {
		const { session, conversationId, sizes, storedText, fire } = await open();
		await append(session, conversationId, "held");
		await expect(
			session.commit(async (tx) => {
				(await tx.doc(TextDoc, conversationId)).text += "!";
				await tx.appendEntry(conversationId, { kind: "test.note" });
				throw new Error("callback failed");
			}, context),
		).rejects.toThrow("callback failed");
		// Its checkpoint predicate throws: settlement fails after every other step.
		await expect(
			session.commit(async (tx) => {
				(await tx.doc(TextDoc, conversationId)).explode = true;
			}, context),
		).rejects.toThrow("checkpoint failed");
		expect(sizes().held).toBe(1);
		await fire();
		expect(await storedText()).toEqual({ text: "held" });
	});

	it("stores every held document in one transaction when the earliest deadline comes", async () => {
		const { session, conversationId, mark, armed, fire, stored, sizes, storage } = await open();
		const other = await createConversation(session);
		await session.commit(async (tx) => void (await tx.doc(TextDoc, other)), context);
		await append(session, conversationId, "one");
		await append(session, other, "two");
		expect(armed().map((timer) => timer.delayMs)).toEqual([1_000]);
		const publications = stored.length;
		const batches = mark();
		await fire();
		expect(batches()).toHaveLength(1);
		expect(changesOf(batches())).toHaveLength(2);
		expect(stored.length).toBe(publications + 1);
		expect(sizes().held).toBe(0);
		expect(armed()).toEqual([]);
		const otherId = (await storage.findDocument(address(other), "current", context))!.id;
		expect((await storage.document(otherId, "current", context))?.value).toEqual({ text: "two" });
	});

	it("arms the earliest deadline of the held commits, each with its withinMs or the default", async () => {
		const { session, conversationId, armed, clock } = await open({ persistWithinMs: 2_000 });
		await append(session, conversationId, "a");
		expect(armed().map((timer) => timer.delayMs)).toEqual([2_000]);
		clock.now += 500;
		// Earlier: the timer moves up.
		await append(session, conversationId, "b", within(100));
		expect(armed().map((timer) => timer.delayMs)).toEqual([100]);
		// Later: the deadline stays.
		await append(session, conversationId, "c", within(60_000));
		expect(armed().map((timer) => timer.delayMs)).toEqual([100]);
	});

	it("arms no timer for an infinite window, and moves the timer on when a commit stores the held document", async () => {
		const { session, conversationId, armed, sizes } = await open();
		await append(session, conversationId, "a", within(Number.POSITIVE_INFINITY));
		expect(armed()).toEqual([]);
		expect(sizes().held).toBe(1);
		await append(session, conversationId, "b");
		expect(armed().map((timer) => timer.delayMs)).toEqual([1_000]);
		await append(session, conversationId, "c", IMMEDIATE);
		expect(armed()).toEqual([]);
		expect(sizes().held).toBe(0);
	});

	it("stores them at close, after the commits admitted before it, and closes Storage when that store fails", async () => {
		const { session, storage, conversationId, recordId } = await open();
		await append(session, conversationId, "held");
		await session.close(context);
		expect((await storage.reopen().document(recordId, "current", context))?.value).toEqual({ text: "held" });

		const failing = await open();
		await append(failing.session, failing.conversationId, "lost");
		const failure = new Error("disk gone");
		failing.storage.failNextCommit(failure);
		await expect(failing.session.close(context)).rejects.toBe(failure);
		expect(await failing.session.closed).toEqual({ kind: "failed", error: failure });
		// Closed: the backend refuses calls until reopened.
		await expect(failing.storage.document(failing.recordId, "current", context)).rejects.toThrow("closed");
		expect((await failing.storage.reopen().document(failing.recordId, "current", context))?.value).toEqual({
			text: "",
		});
	});

	it("stores nothing once the Session failed", async () => {
		const { session, storage, conversationId, recordId, mark } = await open();
		await append(session, conversationId, "lost");
		const batches = mark();
		session.fail(new Error("crash"));
		await session.closed;
		expect(batches()).toEqual([]);
		expect((await storage.reopen().document(recordId, "current", context))?.value).toEqual({ text: "" });
	});

	it("stores them before unloadDocuments() drops the trackers", async () => {
		const { session, conversationId, storedText, sizes } = await open();
		await append(session, conversationId, "held");
		await session.unloadDocuments();
		expect(await storedText()).toEqual({ text: "held" });
		expect(sizes()).toMatchObject({ cached: 0, held: 0 });
		expect(await session.snapshot(TextDoc, conversationId, context)).toEqual({ text: "held" });
	});

	it("stores them before a token of another definition version reloads the document", async () => {
		const { session, conversationId, storedText, mark } = await open();
		await append(session, conversationId, "held");
		const batches = mark();
		expect(await session.snapshot(TextDocV2, conversationId, context)).toEqual({ text: "held", migrated: true });
		expect(changesOf(batches()).map((write) => write.content.kind)).toEqual(["delta"]);
		expect(await storedText()).toEqual({ text: "held" });
		// The same inside a commit, which then migrates with a base.
		await session.commit(async (tx) => void (await tx.doc(TextDoc, conversationId)), context);
		await append(session, conversationId, "+");
		await session.commit(async (tx) => {
			(await tx.doc(TextDocV2, conversationId)).text += "v2";
		}, context);
		expect(await storedText()).toEqual({ text: "held+v2", migrated: true });
	});

	it("stores them before the document's retirement, in the retiring commit", async () => {
		const { session, conversationId, mark, sizes } = await open();
		await append(session, conversationId, "held");
		const batches = mark();
		await session.commit((tx) => tx.retireDoc(TextDoc, conversationId), context);
		expect(batches()[0]!.map((write) => write.type)).toEqual(["document.change", "document.retire"]);
		expect(changesOf(batches())[0]!.content).toEqual({ version: 1, kind: "delta", ops: [["a", ["text"], "held"]] });
		expect(sizes().held).toBe(0);
		expect(await session.snapshot(TextDoc, conversationId, context)).toBeUndefined();
	});
});

describe("bases and overflow", () => {
	it("stores a base when a held commit selected one, and counts the store as one delta otherwise", async () => {
		const { session, conversationId, mark, fire } = await open();
		const batches = mark();
		await session.commit(
			async (tx) => {
				const doc = await tx.doc(TextDoc, conversationId);
				doc.text = "x";
				doc.base = true;
			},
			context,
			DEFERRED,
		);
		await append(session, conversationId, "y");
		await fire();
		expect(changesOf(batches()).map((write) => write.content)).toEqual([
			{ version: 1, kind: "base", value: { text: "xy", base: true } },
		]);
	});

	it("stores the whole value once more than MAX_PENDING_OPS operations are held", async () => {
		const { session, conversationId, mark, fire, stored } = await open();
		await overflow(session, conversationId);
		const batches = mark();
		await fire();
		const value = (await session.snapshot(TextDoc, conversationId, context))!;
		expect(changesOf(batches()).map((write) => write.content)).toEqual([{ version: 1, kind: "base", value }]);
		// A durable listener replaces its copy with the stored value.
		expect(stored.at(-1)!.changes).toMatchObject([{ type: "document", ops: [["r", value]] }]);
	});

	it("stores a base of the commit's own value when it stores an overflowed hold", async () => {
		const { session, conversationId, mark } = await open();
		await overflow(session, conversationId);
		await append(session, conversationId, "a");
		const batches = mark();
		await append(session, conversationId, "b", IMMEDIATE);
		const value = (await session.snapshot(TextDoc, conversationId, context))!;
		expect(value.text).toBe("ab");
		expect(changesOf(batches()).map((write) => write.content)).toEqual([{ version: 1, kind: "base", value }]);
	});
});

/**
 * Hold more than `MAX_PENDING_OPS` operations: deferred commits of one set per key, each below the tracker's own limit,
 * past which a commit is one root replacement.
 */
async function overflow(session: SessionImpl, conversationId: ConversationId): Promise<void> {
	await session.commit(async (tx) => {
		(await tx.doc(TextDoc, conversationId)).keys = {};
	}, context);
	for (let from = 0; from <= MAX_PENDING_OPS; from += 4_000) {
		await session.commit(
			async (tx) => {
				const keys = (await tx.doc(TextDoc, conversationId)).keys!;
				for (let index = from; index < from + 4_000; index++) keys[`k${index}`] = index;
			},
			context,
			DEFERRED,
		);
	}
}

describe("publications", () => {
	it("give observeCommits() exactly what was stored, and nothing for a held commit", async () => {
		const { session, storage, conversationId, recordId, stored, fire } = await open();
		const from = storage.commits.length;
		const publications = stored.length;
		await append(session, conversationId, "a");
		await append(session, conversationId, "b");
		await append(session, conversationId, "c", IMMEDIATE);
		await append(session, conversationId, "d");
		await fire();
		await append(session, conversationId, "e");
		await session.commit(async (tx) => {
			await tx.doc(TextDoc, conversationId);
			await tx.appendEntry(conversationId, { kind: "test.note" });
		}, context);
		await append(session, conversationId, "f");
		await session.close(context);
		const batches = storage.commits.slice(from);
		const published = stored.slice(publications);
		expect(published).toHaveLength(batches.length);
		// A replica built from the publications alone always equals what Storage holds.
		let fromStorage: JsonValue = { text: "" };
		let fromPublications: JsonValue = { text: "" };
		for (const [index, batch] of batches.entries()) {
			const write = changesOf([batch]).find((candidate) => candidate.id === recordId)!;
			const change = published[index]!.changes.find(
				(candidate): candidate is Extract<CommitChange, { kind: "change" }> =>
					candidate.type === "document" && candidate.kind === "change" && candidate.record.id === recordId,
			)!;
			fromStorage =
				write.content.kind === "base" ? write.content.value : applyImmutable(fromStorage, write.content.ops);
			fromPublications = applyImmutable(fromPublications, change.ops);
			expect(fromPublications).toEqual(fromStorage);
			expect(change.value).toEqual(fromStorage);
		}
		expect(fromStorage).toEqual({ text: "abcdef" });
		expect(published.map((publication) => publication.changes.map((change) => change.type).sort())).toEqual([
			["document"],
			["document"],
			["document", "entry"],
			["document"],
		]);
	});

	it("show every held commit to watches and the Session's own observers, once", async () => {
		const { session, conversationId, observed, fire } = await open();
		const watch = (await session.watchDoc(TextDoc, conversationId, context))!;
		const values: string[] = [];
		watch.start(
			onValue(async ({ value }) => {
				values.push(value.text);
			}),
		);
		const from = observed.length;
		for (const text of ["a", "b", "c"]) {
			await append(session, conversationId, text);
			await flush();
		}
		await append(session, conversationId, "d", IMMEDIATE);
		await flush();
		await fire();
		expect(values).toEqual(["a", "ab", "abc", "abcd"]);
		const seen = observed.slice(from);
		expect(seen.map((publication) => publication.kind)).toEqual(["memory", "memory", "memory", "stored"]);
		// The storing commit shows its own operations; the held ones were shown already. The timer showed nothing.
		expect(
			seen.map((publication) =>
				publication.changes.map((change) => change.type === "document" && change.kind === "change" && change.ops),
			),
		).toEqual([
			[[["a", ["text"], "a"]]],
			[[["a", ["text"], "b"]]],
			[[["a", ["text"], "c"]]],
			[[["a", ["text"], "d"]]],
		]);
		await watch.stop();
	});
});

describe("pinning", () => {
	it("keeps a held document cached with retention 0 until it is stored, then lets it go", async () => {
		const { session, conversationId, sizes, fire } = await open({ retentionMs: 0 });
		await session.readOnLine(async () => {});
		expect(sizes()).toMatchObject({ cached: 0, held: 0, attached: 0 });
		await append(session, conversationId, "held");
		await session.readOnLine(async () => {});
		expect(sizes()).toMatchObject({ cached: 1, held: 1, attached: 1 });
		await fire();
		await session.commit(async () => {}, context);
		expect(sizes()).toMatchObject({ cached: 0, held: 0, attached: 0 });
		expect(await session.snapshot(TextDoc, conversationId, context)).toEqual({ text: "held" });
	});

	it("retains a held revision only until it is stored", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const collect = async (): Promise<void> => {
			for (let round = 0; round < 5; round++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				gc();
			}
		};
		const { session, conversationId, fire, stored, observed } = await open({ retentionMs: 0 });
		await append(session, conversationId, "x".repeat(1_000));
		const revision = new WeakRef((await session.snapshot(TextDoc, conversationId, context))!);
		await collect();
		expect(revision.deref()).toBeDefined();
		await fire();
		await session.commit(async () => {}, context);
		// The recorded publications would keep it.
		stored.length = 0;
		observed.length = 0;
		await collect();
		expect(revision.deref()).toBeUndefined();
	});
});

describe("crash", () => {
	it("leaves Storage at the last stored state, which memory had, and nothing held after reopen", async () => {
		const { session, storage, conversationId, recordId, fire } = await open();
		const states: string[] = [];
		session.followCommits((publication) => {
			for (const change of publication.changes) {
				// Publications carry untyped document values; this one is `TextDoc`'s.
				if (change.type === "document" && change.kind === "change" && change.record.id === recordId)
					states.push((change.value as Text).text);
			}
		});
		await append(session, conversationId, "a");
		await fire();
		await append(session, conversationId, "b");
		await append(session, conversationId, "c");
		session.fail(new Error("crash"));
		await session.closed;
		const reopened = new SessionImpl(storage.reopen(), Date.now, () => 600_000);
		const value = (await reopened.snapshot(TextDoc, conversationId, context))!;
		expect(value).toEqual({ text: "a" });
		expect(states).toContain(value.text);
		expect(reopened.documentCacheSizes.held).toBe(0);
		await reopened.close(context);
	});
});
