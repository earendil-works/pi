import type { Draft, JsonValue } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	defineDocFamily,
	type JsonObject,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { context, createConversation, documentChanges, flush, openTestSession } from "./session-support.ts";

type Live = { message?: string; items: string[]; nested: { count: number }; other: { label: string } };

let liveInitCount = 0;
const LiveDoc = defineDoc<Live>({
	kind: "test.live",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => {
		liveInitCount++;
		return { items: [], nested: { count: 0 }, other: { label: "x" } };
	},
});

const RewindableLiveDoc = defineDoc<Live>({
	kind: "test.live",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: [], nested: { count: 0 }, other: { label: "x" } }),
});

const LiveDocV2 = defineDoc<Live>({
	kind: "test.live",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [], nested: { count: 0 }, other: { label: "x" } }),
});

type Counter = { count: number };
const CounterDoc = defineDoc<Counter>({
	kind: "test.counter",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
});

type Member = { seed: string; hits: number };
const seeds: string[] = [];
const MemberDoc = defineDocFamily<Member, string>({
	kind: "test.member",
	version: 1,
	family: true,
	scope: "session",
	initial: (seed) => {
		seeds.push(seed);
		return { seed, hits: 0 };
	},
});

async function setupLive(): Promise<ReturnType<typeof openTestSession> & { readonly conversationId: ConversationId }> {
	const harness = openTestSession();
	const conversationId = await createConversation(harness.session);
	await harness.session.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, conversationId);
		live.items.push("a", "b");
	}, context);
	return { ...harness, conversationId };
}

describe("Session document transactions", () => {
	it("creates an initial base on first access and adopts it after Storage success", async () => {
		const { session, storage, publications } = openTestSession();
		const conversationId = await createConversation(session);
		await session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			live.message = "hello";
		}, context);
		const writes = storage.commits.at(-1)!;
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			type: "document.create",
			record: {
				kind: "test.live",
				scope: { kind: "conversation", conversationId },
				history: "latest",
				fork: "initial",
			},
			content: { kind: "base", version: 1, value: { message: "hello", items: [], nested: { count: 0 } } },
		});
		const snapshot = await session.snapshot(LiveDoc, conversationId, context);
		expect(snapshot).toEqual({ message: "hello", items: [], nested: { count: 0 }, other: { label: "x" } });
		await flush();
		const publication = publications.at(-1)!;
		const published = documentChanges(publication)[0]!;
		expect(published.record.createdAt).toBe(publication.seq);
		expect(published.value).toBe(snapshot);
		expect(published.conversationId).toBe(conversationId);
		const create = storage.admittedCommits.at(-1)!.find((write) => write.type === "document.create")!;
		expect(create.content.value).toBe(published.value);
	});

	it("never creates on snapshot and returns undefined when absent", async () => {
		const { session, storage } = openTestSession();
		const conversationId = await createConversation(session);
		const before = storage.commits.length;
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBeUndefined();
		expect(await session.snapshot(CounterDoc, context)).toBeUndefined();
		expect(await session.snapshot(MemberDoc, "k", context)).toBeUndefined();
		expect(storage.commits.length).toBe(before);
		expect(storage.mintCount).toBe(1);
	});

	it("returns shared immutable snapshots and keeps prior revisions stable", async () => {
		const { session, conversationId } = await setupLive();
		const first = (await session.snapshot(LiveDoc, conversationId, context))!;
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBe(first);
		await session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			live.nested.count = 1;
		}, context);
		const second = (await session.snapshot(LiveDoc, conversationId, context))!;
		expect(second).not.toBe(first);
		expect(first.nested.count).toBe(0);
		expect(second.nested.count).toBe(1);
		// Unchanged subtrees are structurally shared between immutable revisions.
		expect(second.items).toBe(first.items);
		expect(second.other).toBe(first.other);
	});

	it("adopts by pointer swap and shares operation payloads with the published revision", async () => {
		const { session, storage, publications, conversationId } = await setupLive();
		await session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			live.other = { label: "y" };
			live.items.push("c");
		}, context);
		await flush();
		const snapshot = (await session.snapshot(LiveDoc, conversationId, context))!;
		const published = documentChanges(publications.at(-1)!)[0]!;
		expect(published.value).toBe(snapshot);
		const admitted = storage.admittedCommits.at(-1)!.find((write) => write.type === "document.change")!;
		expect(admitted.content.kind).toBe("delta");
		if (admitted.content.kind !== "delta") throw new Error("Expected delta");
		expect(published.ops).toBe(admitted.content.ops);
		const set = published.ops.find((op) => op[0] === "s");
		expect(set).toEqual(["s", ["other"], { label: "y" }]);
		// Trusted immutability: the Session makes no second copy of operation payloads.
		expect(set![2]).toBe(snapshot.other);
	});

	it("copies assigned values per placement", async () => {
		const { session, conversationId } = await setupLive();
		const value = { label: "shared" };
		await session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			live.other = value;
			(live as Draft<Live> & { copy?: { label: string } }).copy = value;
			value.label = "mutated";
		}, context);
		const snapshot = (await session.snapshot(LiveDoc, conversationId, context)) as Live & { copy: { label: string } };
		expect(snapshot.other).toEqual({ label: "shared" });
		expect(snapshot.copy).toEqual({ label: "shared" });
		expect(snapshot.copy).not.toBe(snapshot.other);
		expect(snapshot.other).not.toBe(value);
	});

	it("suppresses writes and publications for empty batches", async () => {
		const { session, storage, publications, conversationId } = await setupLive();
		await flush();
		const commits = storage.commits.length;
		const published = publications.length;
		await session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			live.nested.count = 0;
			live.items.push("z");
			live.items.pop();
		}, context);
		await flush();
		expect(storage.commits.length).toBe(commits);
		expect(publications.length).toBe(published);
	});

	it("writes and publishes replayable nonempty structural no-ops", async () => {
		const { session, storage, publications, conversationId } = await setupLive();
		const before = (await session.snapshot(LiveDoc, conversationId, context))!;
		await session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			const first = live.items.shift()!;
			live.items.unshift(first);
		}, context);
		await flush();
		const writes = storage.commits.at(-1)!;
		expect(writes[0]).toMatchObject({ type: "document.change", content: { kind: "delta" } });
		const after = (await session.snapshot(LiveDoc, conversationId, context))!;
		expect(after).toEqual(before);
		expect(after).not.toBe(before);
		expect(documentChanges(publications.at(-1)!)[0]!.ops.length).toBeGreaterThan(0);
	});

	it("revokes escaped drafts when the callback settles", async () => {
		const { session, conversationId } = await setupLive();
		let escaped: Draft<Live> | undefined;
		let items: Draft<string[]> | undefined;
		await session.commit(async (tx) => {
			escaped = await tx.doc(LiveDoc, conversationId);
			items = escaped.items;
			escaped.message = "inside";
		}, context);
		expect(() => escaped!.message).toThrow();
		expect(() => {
			escaped!.message = "outside";
		}).toThrow();
		expect(() => items!.length).toThrow();
		expect(() => items!.push("outside")).toThrow();
		expect((await session.snapshot(LiveDoc, conversationId, context))!.message).toBe("inside");

		const returned = await session.commit((tx) => tx.doc(LiveDoc, conversationId), context);
		expect(() => returned.message).toThrow();
	});

	it("aborts every change when the callback fails", async () => {
		const { session, storage, conversationId } = await setupLive();
		const before = (await session.snapshot(LiveDoc, conversationId, context))!;
		const commits = storage.commits.length;
		await expect(
			session.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				const counter = await tx.doc(CounterDoc);
				live.message = "lost";
				counter.count = 5;
				throw new Error("callback failed");
			}, context),
		).rejects.toThrow("callback failed");
		expect(storage.commits.length).toBe(commits);
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBe(before);
		expect(await session.snapshot(CounterDoc, context)).toBeUndefined();
		await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).message = "kept";
		}, context);
		expect((await session.snapshot(LiveDoc, conversationId, context))!.message).toBe("kept");
	});

	it("memoizes concurrent duplicate acquisition and initializes once", async () => {
		const { session, storage } = openTestSession();
		const conversationId = await createConversation(session);
		const initCount = liveInitCount;
		const mints = storage.mintCount;
		await session.commit(async (tx) => {
			const [first, second] = await Promise.all([tx.doc(LiveDoc, conversationId), tx.doc(LiveDoc, conversationId)]);
			expect(first).toBe(second);
			expect(await tx.doc(LiveDoc, conversationId)).toBe(first);
			first.message = "once";
		}, context);
		expect(liveInitCount).toBe(initCount + 1);
		expect(storage.mintCount).toBe(mints + 1);
		expect(storage.commits.at(-1)!.filter((write) => write.type === "document.create")).toHaveLength(1);
	});

	it("uses the first family seed and ignores seeds for existing members", async () => {
		const { session } = openTestSession();
		seeds.length = 0;
		await session.commit(async (tx) => {
			const first = await tx.doc(MemberDoc, "k", "first");
			const second = await tx.doc(MemberDoc, "k", "second");
			expect(second).toBe(first);
			first.hits++;
		}, context);
		await session.commit(async (tx) => {
			(await tx.doc(MemberDoc, "k", "third")).hits++;
			(await tx.doc(MemberDoc, "other", "fourth")).hits++;
		}, context);
		expect(seeds).toEqual(["first", "fourth"]);
		expect(await session.snapshot(MemberDoc, "k", context)).toEqual({ seed: "first", hits: 2 });
		expect(await session.snapshot(MemberDoc, "other", context)).toEqual({ seed: "fourth", hits: 1 });
	});

	it("rejects a callback that succeeds with a pending acquisition and drains it", async () => {
		const { session, storage, conversationId } = await setupLive();
		await session.unloadDocuments();
		const gate = storage.holdFindDocument();
		const commits = storage.commits.length;
		let pending: Promise<unknown> | undefined;
		const commit = session.commit((tx) => {
			pending = tx.doc(LiveDoc, conversationId);
		}, context);
		await gate.entered;
		let settled = false;
		void commit.catch(() => {
			settled = true;
		});
		await flush();
		// The line stays held until the late acquisition settles.
		expect(settled).toBe(false);
		gate.release();
		await expect(commit).rejects.toThrow("pending Tx operations");
		await expect(pending).rejects.toThrow("Transaction has settled");
		expect(storage.commits.length).toBe(commits);
		await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).message = "after";
		}, context);
		expect((await session.snapshot(LiveDoc, conversationId, context))!.message).toBe("after");
	});

	it("does not initialize or mint for an absent acquisition that finishes after settlement", async () => {
		const { session, storage } = openTestSession();
		let initialized = 0;
		const LateDoc = defineDoc<Counter>({
			kind: "test.late",
			version: 1,
			scope: "session",
			initial: () => {
				initialized++;
				return { count: 0 };
			},
		});
		const gate = storage.holdFindDocument();
		const mints = storage.mintCount;
		let pending: Promise<unknown> | undefined;
		const commit = session.commit((tx) => {
			pending = tx.doc(LateDoc);
		}, context);
		await gate.entered;
		gate.release();
		await expect(commit).rejects.toThrow("pending Tx operations");
		await expect(pending).rejects.toThrow("Transaction has settled");
		expect(initialized).toBe(0);
		expect(storage.mintCount).toBe(mints);
	});

	it("rejects with the callback error when it fails with a pending acquisition", async () => {
		const { session, storage, conversationId } = await setupLive();
		await session.unloadDocuments();
		const gate = storage.holdFindDocument();
		let pending: Promise<unknown> | undefined;
		const commit = session.commit((tx) => {
			pending = tx.doc(LiveDoc, conversationId);
			throw new Error("callback failed");
		}, context);
		await gate.entered;
		gate.release();
		await expect(commit).rejects.toThrow("callback failed");
		await expect(pending).rejects.toThrow("Transaction has settled");
	});

	it("rejects Tx use after the callback settles", async () => {
		const { session, conversationId } = await setupLive();
		let captured: Parameters<Parameters<typeof session.commit>[0]>[0] | undefined;
		await session.commit((tx) => {
			captured = tx;
		}, context);
		await expect(captured!.doc(LiveDoc, conversationId)).rejects.toThrow("Transaction has settled");
		await expect(captured!.conversation(conversationId)).rejects.toThrow("Transaction has settled");
		expect(() => captured!.setTask({} as never)).toThrow("Transaction has settled");
	});

	it("rejects tokens whose semantics or version disagree with the stored incarnation", async () => {
		const { session, conversationId } = await setupLive();
		await expect(session.snapshot(RewindableLiveDoc, conversationId, context)).rejects.toThrow(
			"does not match the supplied definition semantics",
		);
		await expect(
			session.commit(async (tx) => {
				await tx.doc(RewindableLiveDoc, conversationId);
			}, context),
		).rejects.toThrow("does not match the supplied definition semantics");
		await expect(
			session.commit(async (tx) => {
				await tx.doc(LiveDocV2, conversationId);
			}, context),
		).rejects.toThrow("requires migration from version 1");
	});

	it("rejects non-JSON initializer values and draft placements before Storage admission", async () => {
		const { session, storage } = openTestSession();
		const conversationId = await createConversation(session);
		const DateDoc = defineDoc<JsonObject>({
			kind: "test.date",
			version: 1,
			scope: "session",
			initial: () => ({ at: new Date() }) as unknown as JsonObject,
		});
		await expect(
			session.commit(async (tx) => {
				await tx.doc(DateDoc);
			}, context),
		).rejects.toThrow("strict JSON");
		const commits = storage.commits.length;
		await expect(
			session.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				live.items.push(undefined as unknown as string);
			}, context),
		).rejects.toThrow("strict JSON");
		expect(storage.commits.length).toBe(commits);
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBeUndefined();
	});

	it("rolls back prepared documents when batch assembly fails", async () => {
		const { session, storage, conversationId } = await setupLive();
		await session.commit(async (tx) => {
			(await tx.doc(CounterDoc)).count = 1;
		}, context);
		const live = await session.snapshot(LiveDoc, conversationId, context);
		const counter = await session.snapshot(CounterDoc, context);
		const commits = storage.commits.length;
		await expect(
			session.commit(async (tx) => {
				(await tx.doc(LiveDoc, conversationId)).message = "lost";
				(await tx.doc(CounterDoc)).count = 2;
				// Replacing a missing task fails during assembly, after every change was prepared.
				tx.setTask({
					id: idFromNumber<TaskId<JsonValue>>(999),
					conversationId,
					kind: "missing",
					version: 1,
					input: null,
					after: [],
					background: false,
					abortRequested: false,
					state: { status: "pending", checkpoint: { phase: "start" } },
				});
			}, context),
		).rejects.toThrow("Task 999 does not exist");
		expect(storage.commits.length).toBe(commits);
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBe(live);
		expect(await session.snapshot(CounterDoc, context)).toBe(counter);
		await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).message = "next";
			(await tx.doc(CounterDoc)).count = 3;
		}, context);
		expect((await session.snapshot(CounterDoc, context))!.count).toBe(3);
	});

	it("poisons the Session after an uncertain Storage failure and publishes nothing", async () => {
		const { session, storage, publications, conversationId } = await setupLive();
		await flush();
		const before = (await session.snapshot(LiveDoc, conversationId, context))!;
		const published = publications.length;
		storage.failNextCommit(new Error("disk vanished"));
		await expect(
			session.commit(async (tx) => {
				(await tx.doc(LiveDoc, conversationId)).message = "uncertain";
			}, context),
		).rejects.toThrow("disk vanished");
		await flush();
		expect(publications.length).toBe(published);
		expect(before.message).toBeUndefined();
		await expect(session.snapshot(LiveDoc, conversationId, context)).rejects.toThrow("poisoned");
		await expect(session.commit(() => undefined, context)).rejects.toThrow("poisoned");
		await session.close(context);
	});

	it("keeps the previous revision unchanged through Storage settlement", async () => {
		const { session, storage, conversationId } = await setupLive();
		const before = (await session.snapshot(LiveDoc, conversationId, context))!;
		const copy = structuredClone(before);
		const gate = storage.holdCommits();
		const commit = session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			live.items.push("c");
			live.nested.count = 9;
		}, context);
		await gate.entered;
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBe(before);
		expect(before).toEqual(copy);
		gate.release();
		await commit;
		const after = (await session.snapshot(LiveDoc, conversationId, context))!;
		expect(after.items).toEqual(["a", "b", "c"]);
		expect(before).toEqual(copy);
	});

	it("retires documents and creates a new incarnation at the same address", async () => {
		const { session, storage, publications, conversationId } = await setupLive();
		await flush();
		const oldId = documentChanges(publications.at(-1)!)[0]!.record.id;
		let replacement: Draft<Live> | undefined;
		await session.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			live.message = "final";
			await tx.retireDoc(LiveDoc, conversationId);
			replacement = await tx.doc(LiveDoc, conversationId);
			expect(replacement).not.toBe(live);
			replacement.message = "new";
		}, context);
		const writes = storage.commits.at(-1)!;
		expect(writes).toHaveLength(3);
		expect(writes).toContainEqual(expect.objectContaining({ type: "document.change", id: oldId }));
		expect(writes).toContainEqual({ type: "document.retire", id: oldId });
		expect(writes).toContainEqual(
			expect.objectContaining({ type: "document.create", record: expect.objectContaining({ kind: "test.live" }) }),
		);
		await flush();
		const publication = publications.at(-1)!;
		const [retired, created] = documentChanges(publication);
		expect(retired).toMatchObject({ record: { id: oldId }, value: null, ops: [] });
		expect(retired!.record.retiredAt).toBe(publication.seq);
		expect(created!.record.id).not.toBe(oldId);
		expect(created!.record.createdAt).toBe(publication.seq);
		expect(created).toMatchObject({ value: { message: "new", items: [] }, ops: [] });
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBe(created!.value);

		await session.commit((tx) => tx.retireDoc(LiveDoc, conversationId), context);
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBeUndefined();
		await session.unloadDocuments();
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBeUndefined();
		// Retiring an absent address is a no-op.
		const commits = storage.commits.length;
		await session.commit((tx) => tx.retireDoc(LiveDoc, conversationId), context);
		expect(storage.commits.length).toBe(commits);
	});

	it("retires without acquisition and recreates both existing and absent addresses", async () => {
		const { session, storage, publications, conversationId } = await setupLive();
		await flush();
		const oldId = documentChanges(publications.at(-1)!)[0]!.record.id;
		await session.unloadDocuments();
		await session.commit(async (tx) => {
			const retired = tx.retireDoc(LiveDoc, conversationId);
			const replacement = tx.doc(LiveDoc, conversationId);
			const [live] = await Promise.all([replacement, retired]);
			live.message = "replacement";
		}, context);
		const existingWrites = storage.commits.at(-1)!;
		expect(existingWrites).toHaveLength(2);
		expect(existingWrites).toContainEqual({ type: "document.retire", id: oldId });
		expect(existingWrites).toContainEqual(
			expect.objectContaining({ type: "document.create", record: expect.objectContaining({ kind: "test.live" }) }),
		);

		await session.commit(async (tx) => {
			const retired = tx.retireDoc(MemberDoc, "absent");
			const replacement = tx.doc(MemberDoc, "absent", "seed");
			const [member] = await Promise.all([replacement, retired]);
			member.hits = 1;
		}, context);
		const absentWrites = storage.commits.at(-1)!;
		expect(absentWrites.filter((write) => write.type === "document.retire")).toHaveLength(0);
		expect(absentWrites.filter((write) => write.type === "document.create")).toHaveLength(1);
		expect(await session.snapshot(MemberDoc, "absent", context)).toEqual({ seed: "seed", hits: 1 });
	});

	it("retires the existing incarnation when retirement races a pending acquisition", async () => {
		const { session, storage, publications, conversationId } = await setupLive();
		await flush();
		const oldId = documentChanges(publications.at(-1)!)[0]!.record.id;
		await session.commit(async (tx) => {
			const acquired = tx.doc(LiveDoc, conversationId);
			const retired = tx.retireDoc(LiveDoc, conversationId);
			(await acquired).message = "final";
			await retired;
		}, context);
		const firstWrites = storage.commits.at(-1)!;
		expect(firstWrites).toHaveLength(2);
		expect(firstWrites).toContainEqual({
			type: "document.change",
			id: oldId,
			content: expect.objectContaining({ kind: "delta" }),
		});
		expect(firstWrites).toContainEqual({ type: "document.retire", id: oldId });
		expect(await session.snapshot(LiveDoc, conversationId, context)).toBeUndefined();

		await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).message = "second";
		}, context);
		await flush();
		const secondId = documentChanges(publications.at(-1)!)[0]!.record.id;
		await session.commit(async (tx) => {
			const acquired = tx.doc(LiveDoc, conversationId);
			const retired = tx.retireDoc(LiveDoc, conversationId);
			const recreated = tx.doc(LiveDoc, conversationId);
			const [old, fresh] = await Promise.all([acquired, recreated, retired]);
			expect(fresh).not.toBe(old);
			fresh!.message = "third";
		}, context);
		const writes = storage.commits.at(-1)!;
		expect(writes).toHaveLength(2);
		expect(writes).toContainEqual({ type: "document.retire", id: secondId });
		expect(writes).toContainEqual(
			expect.objectContaining({ type: "document.create", record: expect.objectContaining({ kind: "test.live" }) }),
		);
		expect((await session.snapshot(LiveDoc, conversationId, context))!.message).toBe("third");
	});

	it("reloads an unloaded document from Storage", async () => {
		const { session, conversationId } = await setupLive();
		const loaded = (await session.snapshot(LiveDoc, conversationId, context))!;
		await session.unloadDocuments();
		const reloaded = (await session.snapshot(LiveDoc, conversationId, context))!;
		expect(reloaded).not.toBe(loaded);
		expect(reloaded).toEqual(loaded);
		await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).items.push("c");
		}, context);
		await session.unloadDocuments();
		expect((await session.snapshot(LiveDoc, conversationId, context))!.items).toEqual(["a", "b", "c"]);
	});

	it("delivers publications off the mutation line so listeners can start a nested commit", async () => {
		const { session, publications, conversationId } = await setupLive();
		await flush();
		const published = publications.length;
		let listenerContext: typeof context | undefined;
		const nested = new Promise<void>((resolve, reject) => {
			const unsubscribe = session.subscribeCommits((_publication, deliveredContext) => {
				unsubscribe();
				listenerContext = deliveredContext;
				void session
					.commit(async (tx) => {
						(await tx.doc(CounterDoc)).count = 1;
					}, context)
					.then(resolve, reject);
			});
		});
		const result = await session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).message = "m";
			return "done";
		}, context);
		expect(result).toBe("done");
		await nested;
		expect(listenerContext).toBe(context);
		expect(await session.snapshot(CounterDoc, context)).toEqual({ count: 1 });
		await flush();
		expect(publications.length).toBe(published + 2);
	});

	it("settles admitted commits before close and rejects later admission", async () => {
		const { session, storage, conversationId } = await setupLive();
		const gate = storage.holdCommits();
		const commit = session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).message = "admitted";
		}, context);
		await gate.entered;
		const queued = session.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).message = "queued";
		}, context);
		const admittedSnapshot = session.snapshot(MemberDoc, "absent", context);
		const closed = session.close(context);
		await expect(session.commit(() => undefined, context)).rejects.toThrow("closed");
		await expect(session.snapshot(LiveDoc, conversationId, context)).rejects.toThrow("closed");
		gate.release();
		await commit;
		await queued;
		expect(await admittedSnapshot).toBeUndefined();
		await closed;
		const stored = await storage
			.findDocument({ kind: "test.live", scope: { kind: "conversation", conversationId } }, "current", context)
			.catch((error: unknown) => error);
		expect(stored).toBeInstanceOf(Error);
	});
});
