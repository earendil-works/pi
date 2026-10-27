import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Context, WatchChange, WatchEnd } from "@earendil-works/chord";
import {
	BACKGROUND_CONTEXT,
	createContextKey,
	withAbortSignal,
	withCancel,
	withContextValue,
} from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { type DocumentWatch, defineDoc, defineDocFamily, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { SessionImpl } from "../src/session/session.ts";
import { context, createConversation, documentChanges, flush, openTestSession } from "./session-support.ts";

type State = { value: number; items: string[]; retained: { label: string } };

const StateDoc = defineDoc<State>({
	checkpointWhen: () => false,
	kind: "watch.state",
	version: 1,
	scope: "session",
	initial: () => ({ value: 0, items: ["a", "b"], retained: { label: "stable" } }),
});

type Keys = { keys: Record<string, number> };

const KeysDoc = defineDoc<Keys>({
	checkpointWhen: () => false,
	kind: "watch.keys",
	version: 1,
	scope: "session",
	initial: () => ({ keys: {} }),
});

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** The end of `closed`, or undefined while the watch is open. */
function endOf(watch: { readonly closed: Promise<WatchEnd> }): { readonly end: WatchEnd | undefined } {
	const settled: { end: WatchEnd | undefined } = { end: undefined };
	void watch.closed.then((end) => {
		settled.end = end;
	});
	return settled;
}

async function createState(): Promise<ReturnType<typeof openTestSession>> {
	const harness = openTestSession();
	await harness.session.commit((tx) => tx.doc(StateDoc).then(() => undefined), context);
	return harness;
}

describe("Session document watches", () => {
	it("never creates an absent document", async () => {
		const { session, storage } = openTestSession();
		const commits = storage.commits.length;
		expect(await session.watchDoc(StateDoc, context)).toBeUndefined();
		expect(storage.commits).toHaveLength(commits);
		expect(storage.mintCount).toBe(0);
	});

	it("keeps the acquisition revision until start, then delivers the commits since in one call", async () => {
		const { session, publications } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const initial = watch.value;
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await flush();
		const firstPublished = documentChanges(publications.at(-1)!)[0]!;
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 2;
		}, context);
		await flush();
		const secondPublished = documentChanges(publications.at(-1)!)[0]!;
		expect(watch.value).toBe(initial);

		let inline = true;
		const deliveries: Array<{ value: Readonly<State>; ops: unknown }> = [];
		watch.start(async ({ value, ops }) => {
			expect(inline).toBe(false);
			expect(watch.value).toBe(value);
			deliveries.push({ value, ops });
		});
		inline = false;
		expect(deliveries).toHaveLength(0);
		await flush();
		// Both commits set `value`: folded, the second set replaces the first.
		expect(firstPublished.ops).toEqual([["s", ["value"], 1]]);
		expect(deliveries).toEqual([{ value: secondPublished.value, ops: secondPublished.ops }]);
		expect(deliveries[0]!.value).toBe(secondPublished.value);
		expect(initial?.value).toBe(0);

		// A listener that keeps up gets each commit's ops as published.
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 3;
		}, context);
		await flush();
		const thirdPublished = documentChanges(publications.at(-1)!)[0]!;
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]!.value).toBe(thirdPublished.value);
		expect(deliveries[1]!.ops).toBe(thirdPublished.ops);
		await watch.stop();
	});

	it("serializes callbacks and folds the commits made while one is in flight into the next", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const entered = deferred();
		const release = deferred();
		const values: number[] = [];
		const batches: unknown[] = [];
		let active = 0;
		let maxActive = 0;
		watch.start(async ({ value, ops }) => {
			active++;
			maxActive = Math.max(maxActive, active);
			values.push(value.value);
			batches.push(ops);
			if (values.length === 1) {
				entered.resolve();
				await release.promise;
			}
			active--;
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await entered.promise;
		for (let value = 2; value <= 20; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		expect(values).toEqual([1]);
		release.resolve();
		await flush();
		expect(maxActive).toBe(1);
		expect(values).toEqual([1, 20]);
		expect(batches[1]).toEqual([["s", ["value"], 20]]);
		await watch.stop();
	});

	it("allows a listener to initiate a later Session commit", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const completed = deferred();
		const values: number[] = [];
		watch.start(async ({ value }) => {
			const current = value.value;
			values.push(current);
			if (current === 1) {
				await session.commit(async (tx) => {
					(await tx.doc(StateDoc)).value = 2;
				}, context);
			} else {
				completed.resolve();
			}
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await completed.promise;
		expect(values).toEqual([1, 2]);
		await watch.stop();
	});

	it("folds 101 pending commits of one field into one set", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		for (let value = 1; value <= 101; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		const deliveries: Array<{ value: number; ops: unknown }> = [];
		watch.start(async ({ value, ops }) => {
			deliveries.push({ value: value.value, ops });
		});
		await flush();
		expect(deliveries).toEqual([{ value: 101, ops: [["s", ["value"], 101]] }]);
		await watch.stop();
	});

	it("replaces the root once more than 10,000 ops are pending after folding", async () => {
		const { session } = openTestSession();
		await session.commit((tx) => tx.doc(KeysDoc).then(() => undefined), context);
		const watch = (await session.watchDoc(KeysDoc, context))!;
		// Sets of distinct keys, in commits small enough to stay ops: 4,000 + 4,000 + 2,001 pending ops.
		for (const [from, to] of [
			[0, 4_000],
			[4_000, 8_000],
			[8_000, 10_001],
		] as const) {
			await session.commit(async (tx) => {
				const state = await tx.doc(KeysDoc);
				for (let index = from; index < to; index++) state.keys[`k${index}`] = index;
			}, context);
		}
		const deliveries: Array<{ value: Readonly<Keys>; ops: unknown }> = [];
		watch.start(async ({ value, ops }) => {
			deliveries.push({ value, ops });
		});
		await flush();
		expect(deliveries).toEqual([{ value: watch.value, ops: [["r", watch.value]] }]);
		expect(Object.keys(watch.value.keys)).toHaveLength(10_001);
		await watch.stop();
	});

	it("never folds the in-flight frame into the next call", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const entered = deferred();
		const release = deferred();
		const deliveries: Array<{ value: number; ops: unknown }> = [];
		watch.start(async ({ value, ops }) => {
			deliveries.push({ value: value.value, ops });
			if (deliveries.length === 1) {
				entered.resolve();
				await release.promise;
			}
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await entered.promise;
		for (let value = 2; value <= 102; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		release.resolve();
		await flush();
		expect(deliveries[0]!.value).toBe(1);
		expect(deliveries[1]).toEqual({ value: 102, ops: [["s", ["value"], 102]] });
		expect(deliveries).toHaveLength(2);
		await watch.stop();
	});

	it("folds a retirement into the pending commits' call, which reports it with the last value, and goes on", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		for (let value = 1; value <= 100; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = value;
			}, context);
		}
		const last = (await session.snapshot(StateDoc, context))!;
		await session.commit((tx) => tx.retireDoc(StateDoc), context);
		const changes: WatchChange<Readonly<State>>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		await flush();
		expect(changes).toEqual([{ value: last, ops: [["s", ["value"], 100]], retired: true }]);
		expect(changes[0]!.value).toBe(last);
		expect(watch.value).toBe(last);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 7;
		}, context);
		await flush();
		expect(changes[1]).toEqual({ value: { ...last, value: 7 }, ops: [["r", { ...last, value: 7 }]], retired: false });
		await watch.stop();
	});

	it("delivers replayable structural no-op commits instead of suppressing them", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const initial = watch.value;
		await session.commit(async (tx) => {
			const state = await tx.doc(StateDoc);
			const first = state.items.shift()!;
			state.items.unshift(first);
		}, context);
		const newest = (await session.snapshot(StateDoc, context))!;
		expect(newest).not.toBe(initial);
		expect(newest).toEqual(initial);
		const batches: unknown[] = [];
		watch.start(async ({ value, ops }) => {
			expect(value).toBe(newest);
			batches.push(ops);
		});
		await flush();
		expect(batches).toHaveLength(1);
		expect((batches[0] as readonly unknown[]).length).toBeGreaterThan(0);
		await watch.stop();
	});

	it("preserves commit Context values without inheriting producer cancellation", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const key = createContextKey<string>("watch-test");
		const parentController = new AbortController();
		const commitContext = withContextValue(
			key,
			"newest-commit",
			withAbortSignal(parentController.signal, BACKGROUND_CONTEXT),
		);
		const entered = deferred();
		const release = deferred();
		let deliveryContext: Context | undefined;
		watch.start(async (_change, delivered) => {
			deliveryContext = delivered;
			entered.resolve();
			await release.promise;
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, commitContext);
		await entered.promise;
		expect(deliveryContext!.value(key)).toBe("newest-commit");
		expect(deliveryContext!.abortSignal).toBeUndefined();
		parentController.abort("caller finished");
		const stopped = watch.stop();
		expect(await stopped).toEqual({ reason: "stopped" });
		expect(deliveryContext!.abortSignal).toBeUndefined();
		release.resolve();
	});

	it("keeps earlier immutable revisions stable", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const initial = watch.value;
		let delivered: Readonly<State> | undefined;
		watch.start(async ({ value }) => {
			delivered = value;
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await flush();
		expect(delivered).toBe(watch.value);
		expect(delivered).not.toBe(initial);
		expect(delivered?.retained).toBe(initial.retained);
		expect(initial.value).toBe(0);
		await watch.stop();
	});

	it("reports a change and a retirement in one commit as the retirement, with the value it was given before", async () => {
		const { session, storage } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const before = watch.value;
		const changes: WatchChange<Readonly<State>>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 5;
			await tx.retireDoc(StateDoc);
		}, context);
		await flush();
		// Storage got the change, then the retirement; the commit publishes the retirement only.
		expect(storage.commits.at(-1)!.map((write) => write.type)).toEqual(["document.change", "document.retire"]);
		expect(changes).toEqual([{ value: before, ops: [], retired: true }]);
		expect(changes[0]!.value).toBe(before);
		await watch.stop();
	});

	it("follows its address across a retirement and a recreation in one commit, in one call", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const settled = endOf(watch);
		const changes: WatchChange<Readonly<State>>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		await session.commit(async (tx) => {
			await tx.retireDoc(StateDoc);
			(await tx.doc(StateDoc)).value = 10;
		}, context);
		await flush();
		const recreated = (await session.snapshot(StateDoc, context))!;
		expect(changes).toHaveLength(1);
		expect(changes[0]).toEqual({ value: recreated, ops: [["r", recreated]], retired: true });
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 11;
		}, context);
		await flush();
		expect(changes[1]).toEqual({ value: watch.value, ops: [["s", ["value"], 11]], retired: false });
		expect(watch.value.value).toBe(11);
		expect(settled.end).toBeUndefined();
		await watch.stop();
	});

	it("Session close discards retirement buffered before start", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const baseline = watch.value;
		await session.commit((tx) => tx.retireDoc(StateDoc), context);
		await session.close(context);
		expect(await watch.closed).toEqual({ reason: "ended" });
		expect(watch.value).toBe(baseline);
		expect(() => watch.start(async () => undefined)).toThrow("stopped");
	});

	it("Session close discards retirement behind an in-flight callback", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const entered = deferred();
		const release = deferred();
		const values: number[] = [];
		watch.start(async ({ value }) => {
			values.push(value.value);
			entered.resolve();
			await release.promise;
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await entered.promise;
		await session.commit((tx) => tx.retireDoc(StateDoc), context);
		await session.close(context);
		expect(await watch.closed).toEqual({ reason: "ended" });
		release.resolve();
		await flush();
		expect(values).toEqual([1]);
	});

	it("supports idempotent stop and rejects repeated or late start", async () => {
		const { session } = await createState();
		const started = (await session.watchDoc(StateDoc, context))!;
		started.start(async () => undefined);
		expect(() => started.start(async () => undefined)).toThrow("already started");
		const first = started.stop();
		const second = started.stop();
		expect(second).toBe(first);
		expect(await first).toEqual({ reason: "stopped" });

		const stopped = (await session.watchDoc(StateDoc, context))!;
		await stopped.stop();
		expect(() => stopped.start(async () => undefined)).toThrow("stopped");
	});

	it("cancels acquisition without leaking a registered watch", async () => {
		const { session, storage } = await createState();
		await session.unloadDocuments();
		const gate = storage.holdFindDocument();
		const child = withCancel(context);
		const acquisition = session.watchDoc(StateDoc, child.context);
		await gate.entered;
		child.cancel(new Error("cancel acquisition"));
		gate.release();
		await expect(acquisition).rejects.toThrow("cancel acquisition");
		await session.close(context);
	});

	it("cancels future delivery without aborting an in-flight callback", async () => {
		const { session } = await createState();
		const child = withCancel(context);
		const watch = (await session.watchDoc(StateDoc, child.context))!;
		const entered = deferred();
		const release = deferred();
		let deliveryContext: Context | undefined;
		watch.start(async (_change, delivered) => {
			deliveryContext = delivered;
			entered.resolve();
			await release.promise;
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await entered.promise;
		child.cancel();
		expect(await watch.closed).toEqual({ reason: "cancelled" });
		expect(deliveryContext!.abortSignal).toBeUndefined();
		release.resolve();
	});

	it("Session close stops future delivery without joining an in-flight callback", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const entered = deferred();
		const release = deferred();
		let deliveryContext: Context | undefined;
		watch.start(async (_change, delivered) => {
			deliveryContext = delivered;
			entered.resolve();
			await release.promise;
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		await entered.promise;
		await session.close(context);
		expect(deliveryContext!.abortSignal).toBeUndefined();
		expect(await watch.closed).toEqual({ reason: "ended" });
		release.resolve();
	});

	it("settles listener failure on only the affected watch", async () => {
		const { session } = await createState();
		const failed = (await session.watchDoc(StateDoc, context))!;
		const healthy = (await session.watchDoc(StateDoc, context))!;
		failed.start(async () => {
			throw new Error("listener failed");
		});
		let healthyCalls = 0;
		healthy.start(async () => {
			healthyCalls++;
		});
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 1;
		}, context);
		const end = await failed.closed;
		expect(end.reason).toBe("listener_error");
		if (end.reason === "listener_error") expect(end.error.message).toBe("listener failed");
		await flush();
		expect(healthyCalls).toBe(1);
		await healthy.stop();
	});

	it("hydrates migration without writing and observes the later exact edit", async () => {
		const Old = defineDoc<{ value: number }>({
			checkpointWhen: () => false,
			kind: "watch.migration",
			version: 1,
			scope: "session",
			initial: () => ({ value: 3 }),
		});
		const Current = defineDoc<{ value: number; migrated: boolean }>({
			checkpointWhen: () => false,
			kind: "watch.migration",
			version: 2,
			scope: "session",
			initial: () => ({ value: 0, migrated: false }),
			migrate: (value) => ({ value: value.value as number, migrated: true }),
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		const commits = storage.commits.length;
		const watch = (await session.watchDoc(Current, context))!;
		expect(watch.value).toEqual({ value: 3, migrated: true });
		expect(storage.commits).toHaveLength(commits);
		const values: number[] = [];
		watch.start(async ({ value }) => {
			values.push(value.value);
		});
		await session.commit((tx) => tx.doc(Current).then(() => undefined), context);
		await flush();
		expect(values).toEqual([]);
		await session.commit(async (tx) => {
			(await tx.doc(Current)).value = 4;
		}, context);
		await flush();
		expect(values).toEqual([4]);
		await watch.stop();
	});

	it("can replay every delivered exact operation batch from the acquisition revision", async () => {
		const { session } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		let replica: Readonly<State> = watch.value;
		watch.start(async ({ value, ops }) => {
			replica = applyImmutable(replica, ops);
			expect(replica).toEqual(value);
		});
		await session.commit(async (tx) => {
			const state = await tx.doc(StateDoc);
			state.value = 3;
			state.items.splice(0, 1);
		}, context);
		await flush();
		expect(replica).toEqual(watch.value);
		await watch.stop();
	});

	it("continues after the tracker cache unloads", async () => {
		const { session, storage } = await createState();
		const watch = (await session.watchDoc(StateDoc, context))!;
		const baseline = watch.value;
		const reads = storage.documentReadCount;
		await session.unloadDocuments();
		const reloaded = await session.snapshot(StateDoc, context);
		expect(reloaded).toEqual(baseline);
		expect(reloaded).not.toBe(baseline);
		expect(storage.documentReadCount).toBeGreaterThan(reads);
		watch.start(async () => undefined);
		await session.commit(async (tx) => {
			(await tx.doc(StateDoc)).value = 7;
		}, context);
		await flush();
		expect(watch.value.value).toBe(7);
		await watch.stop();
	});

	it("ignores the same kind in another conversation and under another family key", async () => {
		const Notes = defineDoc<{ text: string }>({
			checkpointWhen: () => false,
			kind: "watch.scoped-notes",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({ text: "" }),
		});
		const Members = defineDocFamily<{ text: string }, null>({
			checkpointWhen: () => false,
			kind: "watch.members",
			version: 1,
			family: true,
			scope: "session",
			initial: () => ({ text: "" }),
		});
		const { session } = openTestSession();
		const watched = await createConversation(session);
		const other = await createConversation(session);
		await session.commit(async (tx) => {
			(await tx.doc(Notes, watched)).text = "a";
			(await tx.doc(Members, "watched", null)).text = "a";
		}, context);
		const notes = (await session.watchDoc(Notes, watched, context))!;
		const member = (await session.watchDoc(Members, "watched", context))!;
		const changes: WatchChange<Readonly<{ text: string }>>[] = [];
		notes.start(async (change) => {
			changes.push(change);
		});
		member.start(async (change) => {
			changes.push(change);
		});
		// The same kinds at other addresses: created, changed, retired, and created again.
		await session.commit(async (tx) => {
			(await tx.doc(Notes, other)).text = "other";
			(await tx.doc(Members, "other", null)).text = "other";
		}, context);
		await session.commit(async (tx) => {
			await tx.retireDoc(Notes, other);
			await tx.retireDoc(Members, "other");
		}, context);
		await session.commit(async (tx) => {
			(await tx.doc(Notes, other)).text = "again";
			(await tx.doc(Members, "other", null)).text = "again";
		}, context);
		await flush();
		expect(changes).toEqual([]);
		expect(session.documentCacheSizes.attached).toBe(2);
		await notes.stop();
		await member.stop();
		await session.close(context);
	});

	it("takes the version of a recreation written by a newer definition, then its ops", async () => {
		const Old = defineDoc<{ value: number }>({
			checkpointWhen: () => false,
			kind: "watch.recreated-version",
			version: 1,
			scope: "session",
			initial: () => ({ value: 1 }),
		});
		const Current = defineDoc<{ value: number; migrated: boolean }>({
			checkpointWhen: () => false,
			kind: "watch.recreated-version",
			version: 2,
			scope: "session",
			initial: () => ({ value: 0, migrated: false }),
			migrate: (value) => ({ value: value.value as number, migrated: true }),
		});
		const { session } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		const watch = (await session.watchDoc(Old, context))!;
		const changes: WatchChange<unknown>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		await session.commit(async (tx) => {
			await tx.retireDoc(Current);
			(await tx.doc(Current)).value = 5;
		}, context);
		await flush();
		await session.commit(async (tx) => {
			(await tx.doc(Current)).value = 6;
		}, context);
		await flush();
		expect(changes).toEqual([
			{
				value: { value: 5, migrated: false },
				ops: [["r", { value: 5, migrated: false }]],
				retired: true,
			},
			{ value: { value: 6, migrated: false }, ops: [["s", ["value"], 6]], retired: false },
		]);
		await watch.stop();
		await session.close(context);
	});

	it("keeps no earlier incarnation alive after a retirement and a recreation, while it goes on", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const collect = async (): Promise<void> => {
			for (let round = 0; round < 5; round++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				gc();
			}
		};
		/** Watch the document, retire and recreate it, and deliver the new value; `drop` then unloads the cache. */
		const follow = async (session: SessionImpl, drop: boolean) => {
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).retained = { label: "first incarnation" };
			}, context);
			const watch = (await session.watchDoc(StateDoc, context))!;
			const first = new WeakRef(watch.value.retained);
			watch.start(async () => {});
			await session.commit(async (tx) => {
				await tx.retireDoc(StateDoc);
				(await tx.doc(StateDoc)).value = 2;
			}, context);
			await flush();
			if (drop) await session.unloadDocuments();
			return { watch, first };
		};
		// Retention 0 evicts the retired incarnation at once; the default keeps the cache until it is unloaded.
		for (const [session, drop] of [
			[new SessionImpl(new MemoryStorage(), Date.now, () => 0), false],
			[new SessionImpl(new MemoryStorage(), Date.now, () => 600_000), true],
		] as const) {
			const { watch, first } = await follow(session, drop);
			await collect();
			expect(watch.value.value).toBe(2);
			expect(watch.value.retained).toEqual({ label: "stable" });
			expect(first.deref()).toBeUndefined();
			await watch.stop();
			await session.close(context);
		}
	});

	it("keeps a watch of a retired conversation document until it is stopped, then nothing of it", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const collect = async (): Promise<void> => {
			for (let round = 0; round < 5; round++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				gc();
			}
		};
		const Notes = defineDoc<{ text: string }>({
			checkpointWhen: () => false,
			kind: "watch.notes",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({ text: "" }),
		});
		const { session } = openTestSession();
		const conversationId = await createConversation(session);
		/** A started watch of a document that is then retired; `stop` says whether to stop it before returning. */
		const acquire = async (stop: boolean) => {
			await session.commit(async (tx) => {
				(await tx.doc(Notes, conversationId)).text = "kept";
			}, context);
			const watch = (await session.watchDoc(Notes, conversationId, context))!;
			const listener = async (): Promise<void> => {};
			watch.start(listener);
			await session.commit((tx) => tx.retireDoc(Notes, conversationId), context);
			await flush();
			if (stop) await watch.stop();
			return { watch: new WeakRef(watch), listener: new WeakRef(listener) };
		};
		// A watch follows its address, so a forgotten one stays until it is stopped or the Session ends.
		const forgotten = await acquire(false);
		await collect();
		expect(forgotten.watch.deref()).toBeDefined();
		await forgotten.watch.deref()!.stop();

		const stopped = await acquire(true);
		await collect();
		expect(stopped.watch.deref()).toBeUndefined();
		expect(stopped.listener.deref()).toBeUndefined();
		await session.close(context);
	});

	it("retains neither its Session nor its listener once stopped, while still referenced", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const collect = async (): Promise<void> => {
			for (let round = 0; round < 5; round++) {
				await new Promise((resolve) => setTimeout(resolve, 0));
				gc();
			}
		};
		/** A watch of a Session nothing else references; `stop` says whether to stop it before returning. */
		const acquire = async (stop: boolean) => {
			// No eviction timer, so nothing but the watch can keep the Session alive.
			const session = new SessionImpl(
				new MemoryStorage(),
				Date.now,
				() => Number.POSITIVE_INFINITY,
				() => () => {},
			);
			await session.commit((tx) => tx.doc(StateDoc).then(() => undefined), context);
			const watch: DocumentWatch<State> = (await session.watchDoc(StateDoc, context))!;
			const listener = async (): Promise<void> => {};
			watch.start(listener);
			await session.commit(async (tx) => {
				(await tx.doc(StateDoc)).value = 1;
			}, context);
			await flush();
			if (stop) await watch.stop();
			return { watch, session: new WeakRef(session), listener: new WeakRef(listener) };
		};

		// Control: a running watch keeps its Session, so the collection below is real.
		const running = await acquire(false);
		await collect();
		expect(running.session.deref()).toBeDefined();
		await running.watch.stop();

		const stopped = await acquire(true);
		await collect();
		expect(stopped.session.deref()).toBeUndefined();
		expect(stopped.listener.deref()).toBeUndefined();
		// What it delivered last stays readable.
		expect(stopped.watch.value.value).toBe(1);
		expect(await stopped.watch.closed).toEqual({ reason: "stopped" });
	});
});
