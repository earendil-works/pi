import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import type { Draft } from "../../../src/delta/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type KeyedHandle, type SingletonHandle, type Tx } from "../../../src/next/documents/index.ts";
import type { Staged, Transaction } from "../../../src/next/documents/internal.ts";
import type { Self } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { query } from "../../../src/next/store/query.ts";
import type { StagedWrite as StoreStaged } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import type { TableOf } from "../../../src/next/store/table-handle.ts";
import {
	delivered,
	framesOf,
	instancesOf,
	loaded,
	memoryStore,
	metered,
	rejection,
	restartable,
	storeRestartable,
} from "../support.ts";

const instances = instancesOf(ChordObject, "attempt");

const A = defineState("a", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const B = defineState("b", { schema: obj({ s: str() }), version: 1, initial: () => ({ s: "" }) });
const Owner = local("app.owner", { version: 1, params: { id: int() }, members: { sum: str() } });

type Handles = {
	readonly self: Self;
	readonly a: SingletonHandle<{ n: number }>;
	readonly b: SingletonHandle<{ s: string }>;
};

/** Objects with two documents and a derive over them; returns each object's handles. */
async function objects(telemetry?: Awaited<ReturnType<typeof metered>>["telemetry"]) {
	const handles = new Map<number, Handles>();
	const { host } = await loaded(
		(h) => {
			h.serve(Owner, ({ id }, self) => {
				const a = self.state(A);
				const b = self.state(B);
				handles.set(id, { self, a, b });
				return { sum: self.derive([a, b], ([x, y]) => `${x.n}${y.s}`) };
			});
		},
		{ telemetry },
	);
	const reference = await host.get(Owner, { id: 1 }, context);
	await host.get(Owner, { id: 2 }, context);
	return { reference, one: handles.get(1)!, two: handles.get(2)! };
}

describe("transactions", () => {
	it("run one at a time per object and return what their callback returns", async () => {
		const { one } = await objects();
		const order: string[] = [];
		const gate = Promise.withResolvers<void>();
		const first = one.self.tx(async (tx) => {
			order.push("first");
			await gate.promise;
			(await tx.draft(one.a)).n = 1;
			order.push("first done");
			return "one";
		}, context);
		const second = one.self.tx(async (tx) => {
			order.push(`second sees ${one.a.value.n}`);
			(await tx.draft(one.a)).n++;
			return "two";
		}, context);
		await delivered();
		gate.resolve();
		expect(await Promise.all([first, second])).toEqual(["one", "two"]);
		expect(order).toEqual(["first", "first done", "second sees 1"]);
		expect(one.a.value).toEqual({ n: 2 });
	});

	it("give the same draft for the same document", async () => {
		const { one } = await objects();
		await one.self.tx(async (tx) => {
			expect(await tx.draft(one.a)).toBe(await tx.draft(one.a));
		}, context);
	});

	it("settle a warm draft at once: a continuation the callback did not await runs before the commit (rule 3)", async () => {
		const { one } = await objects();
		await one.self.tx((tx) => {
			void tx.draft(one.a).then((draft) => {
				draft.n = 7;
			});
		}, context);
		expect(one.a.value).toEqual({ n: 7 });
	});

	it("reject a draft of a handle a transaction cannot use instead of throwing", async () => {
		const { one, two } = await objects();
		await one.self.tx(async (tx) => {
			const draft = tx.draft(two.a);
			expect(draft).toBeInstanceOf(Promise);
			await expect(draft).rejects.toThrow("drafts only its own object's documents");
		}, context);
	});

	it("commit nothing when nothing changed", async () => {
		const telemetry = await metered();
		const { one, reference } = await objects(telemetry.telemetry);
		const frames = framesOf(await reference.sum.watch(context));
		const value = one.a.value;
		const computes = telemetry.counts()["chord.derive.computes"];
		await one.self.tx(async (tx) => {
			void (await tx.draft(one.a)).n;
		}, context);
		await delivered();
		expect(one.a.value).toBe(value);
		expect(frames).toEqual([]);
		expect(telemetry.counts()["chord.derive.computes"]).toBe(computes);
	});

	it("discard everything on a throw and on an aborted context", async () => {
		const { one } = await objects();
		const change = async (tx: Tx) => {
			(await tx.draft(one.a)).n = 5;
		};
		await expect(
			one.self.tx(async (tx) => {
				await change(tx);
				throw new Error("no");
			}, context),
		).rejects.toThrow("no");
		const { context: cancelled, cancel } = withCancel(context);
		await expect(
			one.self.tx(async (tx) => {
				await change(tx);
				cancel(new Error("cancelled"));
			}, cancelled),
		).rejects.toThrow("cancelled");
		expect(one.a.value).toEqual({ n: 0 });
	});

	it("revoke their drafts when they settle", async () => {
		const { one } = await objects();
		let kept: Draft<{ n: number }> | undefined;
		await one.self.tx(async (tx) => {
			kept = await tx.draft(one.a);
			kept.n = 1;
		}, context);
		expect(() => kept!.n).toThrow();
		await expect(one.self.tx(async (tx) => tx, context).then((tx) => tx.draft(one.a))).rejects.toThrow(
			"app.owner(1): the transaction has settled",
		);
	});

	it("refuse another object's documents", async () => {
		const { one, two } = await objects();
		expect(await rejection(one.self.tx((tx) => tx.draft(two.a), context))).toEqual(
			new Error("app.owner(1): a transaction drafts only its own object's documents"),
		);
	});

	it("commit the object's documents in one batch: one compute, one frame", async () => {
		const telemetry = await metered();
		const { one, reference } = await objects(telemetry.telemetry);
		const frames = framesOf(await reference.sum.watch(context));
		const computes = telemetry.counts()["chord.derive.computes"]!;
		await one.self.tx(async (tx) => {
			(await tx.draft(one.a)).n = 1;
			(await tx.draft(one.b)).s = "b";
		}, context);
		await delivered();
		expect(frames).toEqual([["1b", [["r", "1b"]]]]);
		expect(telemetry.counts()["chord.derive.computes"]).toBe(computes + 1);
	});

	it("commit their other changes when they retire an absent document (R13)", async () => {
		const { one } = await objects();
		await one.self.tx(async (tx) => {
			await tx.retire(one.b);
			(await tx.draft(one.a)).n = 7;
		}, context);
		expect([one.a.value, one.b.value]).toEqual([{ n: 7 }, { s: "" }]);
	});

	it("draft a retired document anew: watches get a root replacement", async () => {
		const { one } = await objects();
		await one.a.change((draft) => {
			draft.n = 3;
		}, context);
		const frames = framesOf(await one.a.watch(context));
		await one.self.tx(async (tx) => {
			await tx.retire(one.a);
			(await tx.draft(one.a)).n += 1;
		}, context);
		await delivered();
		expect(frames).toEqual([[{ n: 1 }, [["r", { n: 1 }]]]]);
	});
});

describe("the in-memory change's cost", () => {
	it("settles an in-memory change within five microtask turns (a guard: an extra await per tx operation shows here)", async () => {
		const { one } = await objects();
		for (let run = 0; run < 3; run++) {
			let turns = 0;
			let running = true;
			const change = one.a.change((draft) => {
				draft.n++;
			}, context);
			void change.then(() => {
				running = false;
			});
			while (running) {
				turns++;
				await null;
			}
			await change;
			expect(turns).toBeLessThanOrEqual(5);
		}
		expect(one.a.value.n).toBe(3);
	});
});

describe("staged changes", () => {
	/** A staged change recording what happens to it, and the document value its adoption sees. */
	function recorder(events: string[], a: SingletonHandle<{ n: number }>): Staged {
		return {
			adopt: () => void events.push(`adopt sees ${a.value.n}`),
			committed: () => void events.push("committed"),
			discarded: () => void events.push("discarded"),
		};
	}

	it("adopt in the commit step with the documents, then hear of the commit once the line is free", async () => {
		const { one } = await objects();
		const events: string[] = [];
		const owner = {};
		await one.self.tx(async (tx) => {
			(await tx.draft(one.a)).n = 7;
			const transaction = tx as Transaction;
			const staged = transaction.stage(owner, () => recorder(events, one.a));
			// One per owner and transaction.
			expect(transaction.stage(owner, () => recorder([], one.a))).toBe(staged);
			events.push("callback done");
		}, context);
		expect(events).toEqual(["callback done", "adopt sees 7", "committed"]);
	});

	it("adopt without any document change, and hear of a discard instead when the transaction throws", async () => {
		const { one } = await objects();
		const events: string[] = [];
		await one.self.tx((tx) => void (tx as Transaction).stage({}, () => recorder(events, one.a)), context);
		await rejection(
			one.self.tx((tx) => {
				(tx as Transaction).stage({}, () => recorder(events, one.a));
				throw new Error("no");
			}, context),
		);
		expect(events).toEqual(["adopt sees 0", "committed", "discarded"]);
	});
});

describe("the seal fence", () => {
	const N = defineState("n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

	/** A restartable object with `N`; its handles by attempt. */
	async function sealable() {
		const handles: SingletonHandle<{ n: number }>[] = [];
		const object = await restartable(instances, (_, self) => {
			handles.push(self.state(N));
		});
		return { ...object, handles };
	}

	it("discards the transaction holding the line at the seal: the line is free, its later uses are refused", async () => {
		const { attempts, handles, restart } = await sealable();
		const gate = Promise.withResolvers<void>();
		let held: Tx | undefined;
		const first = attempts[0]!.tx(async (tx) => {
			(await tx.draft(handles[0]!)).n = 1;
			held = tx;
			await gate.promise;
			return "late";
		}, context);
		await delivered();
		await restart();
		// The next attempt's transaction runs while the cut one's callback still waits.
		await handles[1]!.change((draft) => {
			draft.n = 2;
		}, context);
		gate.resolve();
		expect(await rejection(first)).toMatchObject({ code: "released" });
		expect(await rejection(held!.draft(handles[1]!))).toMatchObject({
			code: "released",
			message: "app.restartable(1): the transaction was discarded at the seal",
		});
		expect(handles[1]!.value).toEqual({ n: 2 });
	});

	it("refuses a sealed attempt's transactions waiting for the line and every new one; its handles still read", async () => {
		const { attempts, handles, fail } = await sealable();
		const gate = Promise.withResolvers<void>();
		const first = attempts[0]!.tx(() => gate.promise, context);
		const queued = handles[0]!.change((draft) => {
			draft.n = 1;
		}, context);
		await delivered();
		fail();
		expect(await rejection(queued)).toMatchObject({ code: "released" });
		expect(await rejection(handles[0]!.change(() => {}, context))).toMatchObject({ code: "released" });
		expect(handles[0]!.value).toEqual({ n: 0 });
		gate.resolve();
		expect(await rejection(first)).toMatchObject({ code: "released" });
	});
});

describe("tables in a transaction", () => {
	const N = defineState("n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
	const Edits = defineTable("edits", { version: 1, columns: { id: str(), at: int() }, key: ["id"] });
	type EditsTable = TableOf<typeof Edits>;

	/** A store object with `N` and `Edits`, on a store with an outbox; its handles by attempt. */
	async function stored(telemetry?: Awaited<ReturnType<typeof metered>>["telemetry"]) {
		const store: ChordStore = await memoryStore({ outbox: true });
		const handles: { n: SingletonHandle<{ n: number }>; edits: EditsTable }[] = [];
		const object = await storeRestartable(
			instances,
			(_, self) => {
				handles.push({ n: self.state(N), edits: self.table(Edits) });
			},
			{ store, telemetry },
		);
		return { ...object, store, handles, self: object.attempts[0]!, ...handles[0]! };
	}

	it("commit rows and documents in one step: the documents adopt inside it, one seq", async () => {
		const { self, n, edits, store, host } = await stored();
		const watch = await n.watch(context);
		const seen: number[] = [];
		watch.start(async () => {
			seen.push(store.lastSeq);
		});
		await delivered();
		const before = store.lastSeq;
		await self.tx(async (tx) => {
			tx.put(edits, { id: "e1", at: 1 });
			(await tx.draft(n)).n = 1;
		}, context);
		await delivered();
		expect(store.lastSeq).toBe(before + 1);
		expect(seen.at(-1)).toBe(before + 1);
		expect(n.value).toEqual({ n: 1 });
		expect(await edits.get({ id: "e1" }, context)).toEqual({ id: "e1", at: 1 });
		watch.stop();
		await host.close(context);
		await store.close(context);
	});

	it("in-memory-only commits take no step and no seq (W12)", async () => {
		const { telemetry, context: counting, counts } = await metered();
		const { self, n, store, host } = await stored(telemetry);
		const commits = counts()["chord.store.commits"] ?? 0;
		const seq = store.lastSeq;
		await self.tx(async (tx) => {
			(await tx.draft(n)).n = 5;
		}, counting);
		expect(store.lastSeq).toBe(seq);
		expect(counts()["chord.store.commits"] ?? 0).toBe(commits);
		await host.close(context);
		await store.close(context);
	});

	it("read committed rows with tx.page and tx.rows, overlay own writes with tx.get", async () => {
		const { self, edits, store, host } = await stored();
		await self.tx((tx) => tx.put(edits, { id: "e1", at: 1 }), context);
		await self.tx(async (tx) => {
			tx.put(edits, { id: "e2", at: 2 });
			expect((await tx.page(edits, query(Edits), 10)).items.map((row) => row.id)).toEqual(["e1"]);
			const all: string[] = [];
			for await (const row of tx.rows(edits, query(Edits))) all.push(row.id);
			expect(all).toEqual(["e1"]);
			expect(await tx.get(edits, { id: "e2" })).toEqual({ id: "e2", at: 2 });
		}, context);
		expect(await edits.count(query(Edits), context)).toBe(2);
		await host.close(context);
		await store.close(context);
	});

	it("write nothing on a throw or an abort, and refuse a callback that settles with a pending read (rule 3)", async () => {
		const { self, edits, store, host } = await stored();
		const seq = store.lastSeq;
		await expect(
			self.tx((tx) => {
				tx.put(edits, { id: "e1", at: 1 });
				throw new Error("no");
			}, context),
		).rejects.toThrow("no");
		const { context: cancelled, cancel } = withCancel(context);
		const aborted = self.tx(async (tx) => {
			tx.put(edits, { id: "e1", at: 1 });
			cancel();
		}, cancelled);
		await expect(aborted).rejects.toThrow();
		await expect(
			self.tx((tx) => {
				void tx.get(edits, { id: "e1" });
				tx.put(edits, { id: "e1", at: 1 });
			}, context),
		).rejects.toThrow("settled before its pending tx operations");
		expect(store.lastSeq).toBe(seq);
		expect(await edits.count(query(Edits), context)).toBe(0);
		await host.close(context);
		await store.close(context);
	});

	it("refuse another object's table", async () => {
		const { self, store, host } = await stored();
		const other = await stored();
		await expect(self.tx((tx) => tx.put(other.edits, { id: "e1", at: 1 }), context)).rejects.toThrow(
			"writes only its own object's tables",
		);
		await host.close(context);
		await other.host.close(context);
		await store.close(context);
		await other.store.close(context);
	});

	it("a commit queued behind another owner's step is refused at the seal; an admitted one is adopted", async () => {
		const { attempts, handles, store, fail, retry, host } = await stored();
		// Hold the commit queue with a step that waits.
		const gate = Promise.withResolvers<void>();
		const holding = store.commit(
			[
				{
					order: "write",
					apply: async () => {
						await gate.promise;
						return [{ kind: "dropIndex", table: "x", name: "y" }];
					},
				},
			],
			{ admit: () => true, adopt: () => {} },
			context,
		);
		const queued = attempts[0]!.tx(async (tx) => {
			tx.put(handles[0]!.edits, { id: "e1", at: 1 });
			(await tx.draft(handles[0]!.n)).n = 1;
		}, context);
		await delivered();
		fail();
		gate.resolve();
		await holding.catch(() => {});
		expect(await rejection(queued)).toMatchObject({ code: "released" });
		await retry();
		expect(handles[1]!.n.value).toEqual({ n: 0 });
		expect(await handles[1]!.edits.get({ id: "e1" }, context)).toBeUndefined();
		// Admitted, then sealed while in the step: durable, adopted into the object's slots, `self.tx` resolves.
		const commit = store.commit.bind(store);
		store.commit = (writes, fence, ctx) =>
			commit(writes, { admit: () => sealedAfter(fence.admit()), adopt: fence.adopt }, ctx);
		const sealedAfter = (admitted: boolean): boolean => {
			if (admitted) fail();
			return admitted;
		};
		const admitted = await attempts[1]!.tx(async (tx) => {
			tx.put(handles[1]!.edits, { id: "e2", at: 2 });
			(await tx.draft(handles[1]!.n)).n = 2;
			return "done";
		}, context);
		store.commit = commit;
		expect(admitted).toBe("done");
		await retry();
		expect(handles[2]!.n.value).toEqual({ n: 2 });
		expect(await handles[2]!.edits.get({ id: "e2" }, context)).toEqual({ id: "e2", at: 2 });
		await host.close(context);
		await store.close(context);
	});
});

describe("persisted documents in a transaction", () => {
	const N = defineState("n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
	const P = defineState("p", {
		schema: obj({ n: int() }),
		version: 1,
		initial: () => ({ n: 0 }),
		persist: true,
		checkpointWhen: () => false,
	});
	const K = defineState("k", {
		schema: obj({ n: int() }),
		version: 1,
		initial: () => ({ n: 0 }),
		keyed: true,
		persist: true,
		checkpointWhen: () => false,
	});

	/** A store object with in-memory `N`, persisted `P` and keyed persisted `K`, on a store with an outbox. */
	async function stored(telemetry?: Awaited<ReturnType<typeof metered>>["telemetry"], on?: ChordStore) {
		const store: ChordStore = on ?? (await memoryStore({ outbox: true }));
		const handles: {
			n: SingletonHandle<{ n: number }>;
			p: SingletonHandle<{ n: number }>;
			k: KeyedHandle<{ n: number }>;
		}[] = [];
		const object = await storeRestartable(
			instances,
			(_, self) => {
				handles.push({ n: self.state(N), p: self.state(P), k: self.state(K) });
			},
			{ store, telemetry },
		);
		return { ...object, store, self: object.attempts[0]!, ...handles[0]! };
	}

	it("commit persisted and in-memory documents in one step; a delta commit takes three statements", async () => {
		const { telemetry, context: counting, counts } = await metered();
		const { self, n, p, store, host } = await stored(telemetry);
		await self.tx(async (tx) => {
			(await tx.draft(n)).n = 1;
			(await tx.draft(p)).n = 1;
		}, counting);
		expect(store.lastSeq).toBe(1);
		const before = { ...counts() };
		await self.tx(async (tx) => {
			(await tx.draft(p)).n = 2;
		}, counting);
		expect(counts()["chord.store.commits"]! - before["chord.store.commits"]!).toBe(1);
		// The revision, the record's conditional UPDATE, lastSeq; plus the outbox commit.
		expect(counts()["chord.store.statements"]! - before["chord.store.statements"]!).toBe(4);
		expect([n.value, p.value]).toEqual([{ n: 1 }, { n: 2 }]);
		await host.close(context);
		await store.close(context);
	});

	it("a keyed retirement takes 6a's statements: the counted DELETE, the revisions, lastSeq (cost guard)", async () => {
		const { telemetry, context: counting, counts } = await metered();
		const { self, k, store, host } = await stored(telemetry);
		await self.tx(async (tx) => {
			(await tx.draft(k, "a")).n = 1;
		}, counting);
		const before = { ...counts() };
		await self.tx(async (tx) => {
			await tx.retire(k, "a");
		}, counting);
		// No read of the record first, no second DELETE of its row; plus the outbox commit.
		expect(counts()["chord.store.statements"]! - before["chord.store.statements"]!).toBe(4);
		await host.close(context);
		await store.close(context);
	});

	it("assign the created documents' ids by their order in the commit; retire and recreate in one commit", async () => {
		const { self, k, store, host } = await stored();
		await self.tx(async (tx) => {
			(await tx.draft(k, "b")).n = 1;
			(await tx.draft(k, "a")).n = 2;
		}, context);
		await self.tx(async (tx) => {
			await tx.retire(k, "b");
			(await tx.draft(k, "b")).n = 3;
		}, context);
		const commits = await store.outbox!.read(0, 10, context);
		const created = commits.flatMap(({ writes }) =>
			writes.flatMap((write) => (write.kind === "document.create" ? [[write.record.key, write.record.id]] : [])),
		);
		expect(created).toEqual([
			["b", 2],
			["a", 3],
			["b", 4],
		]);
		expect(commits[1]!.writes.map(({ kind }) => kind)).toEqual(["document.retire", "document.create"]);
		// What is stored of `b` is the new record's: the next change is a delta on it.
		await k.change(
			"b",
			(draft) => {
				draft.n = 4;
			},
			context,
		);
		expect((await store.outbox!.read(2, 10, context))[0]!.writes).toMatchObject([{ kind: "document.change", id: 4 }]);
		await host.close(context);
		await store.close(context);
	});

	it("draft a cold keyed document by loading it inside the transaction; refuse a callback with a pending load", async () => {
		const first = await stored();
		const { store } = first;
		await first.k.change(
			"a",
			(draft) => {
				draft.n = 1;
			},
			context,
		);
		await first.host.close(context);
		const { self, k, host } = await stored(undefined, store);
		await self.tx(async (tx) => {
			(await tx.draft(k, "a")).n += 1;
		}, context);
		expect(await k.get("a", context)).toEqual({ n: 2 });
		await expect(
			self.tx(async (tx) => {
				// Not awaited: the draft is still loading when the callback returns (it rejects later, settled).
				tx.draft(k, "b").catch(() => {});
			}, context),
		).rejects.toThrow("the callback settled before its pending tx operations");
		await host.close(context);
		await store.close(context);
	});

	it("settle a warm keyed draft at once: a continuation the callback did not await runs before the commit", async () => {
		const { self, k, host, store } = await stored();
		await self.tx(async (tx) => {
			(await tx.draft(k, "a")).n = 1;
		}, context);
		await self.tx((tx) => {
			void tx.draft(k, "a").then((draft) => {
				draft.n = 7;
			});
		}, context);
		expect(await k.get("a", context)).toEqual({ n: 7 });
		await host.close(context);
		await store.close(context);
	});

	it("a commit cut at the seal while it waits in the store's queue rejects released at once, writing nothing", async () => {
		const { p, store, host } = await stored();
		// A suspended export holds the commit queue.
		const parts = store.export(context);
		await parts.next();
		const change = rejection(
			p.change((draft) => {
				draft.n = 5;
			}, context),
		);
		await delivered();
		await host.close(context);
		expect(await change).toMatchObject({ code: "released" });
		await parts.return!();
		expect(store.lastSeq).toBe(0);
		const next = await stored(undefined, store);
		expect(next.p.value).toEqual({ n: 0 });
		await next.p.change((draft) => {
			draft.n = 6;
		}, context);
		expect(store.lastSeq).toBe(1);
		await next.host.close(context);
		await store.close(context);
	});

	it("a host closing while an admitted commit is in the SQL waits for its adoption; the store stays usable", async () => {
		const { p, store, host } = await stored();
		// The next commit's step waits inside the backend transaction, after its admission.
		const gate = Promise.withResolvers<void>();
		const inStep = Promise.withResolvers<void>();
		const commit = store.commit.bind(store);
		store.commit = (writes, fence, ctx) => {
			const held: StoreStaged = {
				order: "write",
				apply: async () => {
					inStep.resolve();
					await gate.promise;
					return [{ kind: "dropIndex", table: "x", name: "y" }];
				},
			};
			return commit([...writes, held], fence, ctx);
		};
		// Not from a method handler: the drain does not wait for it.
		const change = p.change((draft) => {
			draft.n = 5;
		}, context);
		await inStep.promise;
		let closed = false;
		const closing = host.close(context).then(() => {
			closed = true;
		});
		await delivered();
		expect(closed).toBe(false);
		gate.resolve();
		await change;
		await closing;
		store.commit = commit;
		expect(store.lastSeq).toBe(1);
		const next = await stored(undefined, store);
		expect(next.p.value).toEqual({ n: 5 });
		await next.p.change((draft) => {
			draft.n = 6;
		}, context);
		expect(store.lastSeq).toBe(2);
		await next.host.close(context);
		await store.close(context);
	});

	it("a handler's commit held in the SQL past closeTimeout still adopts before the object ends; the store stays usable", async () => {
		const Writer = local("app.writer", { version: 1, params: {}, members: { write: method() } });
		const store = await memoryStore({ outbox: true });
		const serve = (h: Parameters<Parameters<typeof loaded>[0]>[0]) =>
			h.serve(Writer, (_, self) => {
				const p = self.state(P);
				return {
					write: async (ctx) => {
						await p.change((draft) => {
							draft.n++;
						}, ctx);
						return null;
					},
				};
			});
		const { host, errors } = await loaded(serve, { store, closeTimeout: 20 });
		const gate = Promise.withResolvers<void>();
		const inStep = Promise.withResolvers<void>();
		const commit = store.commit.bind(store);
		store.commit = (writes, fence, ctx) => {
			const held: StoreStaged = {
				order: "write",
				apply: async () => {
					inStep.resolve();
					await gate.promise;
					return [{ kind: "dropIndex", table: "x", name: "y" }];
				},
			};
			return commit([...writes, held], fence, ctx);
		};
		const call = rejection((await host.get(Writer, {}, context)).write(context));
		await inStep.promise;
		let closed = false;
		const closing = host.close(context).then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		// The drain gave up on the handler; the object's teardown still waits for the admitted step.
		expect(errors.map(({ kind }) => kind)).toEqual(["drain_timeout"]);
		expect(closed).toBe(false);
		gate.resolve();
		await closing;
		// The stuck call was released at the end; its commit, admitted before, is durable and was adopted.
		expect(await call).toMatchObject({ code: "released" });
		store.commit = commit;
		expect(store.lastSeq).toBe(1);
		const next = await loaded(serve, { store });
		await (await next.host.get(Writer, {}, context)).write(context);
		expect(store.lastSeq).toBe(2);
		expect(next.errors).toEqual([]);
		await next.host.close(context);
		await store.close(context);
	});
});
