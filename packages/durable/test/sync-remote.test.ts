// The sync protocol over stores with an outbox: slots created once, uploads from the outbox, pulls through
// `applyBatch()`, archives for sessions whose outbox does not reach back, folds into snapshots.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { idFromNumber, seqFromNumber } from "../src/ids.ts";
import {
	type BatchInfo,
	decodeBatch,
	encodeBatch,
	FileSyncStateStore,
	FileSystemSyncRemote,
	FlushScheduler,
	foldSession,
	HistoryUnavailableError,
	isUrgentCommit,
	LOG_START,
	OutboxUnavailableError,
	pullSession,
	readOutbox,
	remoteHead,
	remoteHistory,
	type SessionSyncMaintenance,
	type SyncState,
	type SyncStateStore,
	UnsyncedCommitsError,
	uploadSession,
} from "../src/sync/index.ts";
import {
	type CommitPublication,
	type DocumentCreate,
	type DocumentId,
	type EntryId,
	ROOT_CONVERSATION_ID,
	type Seq,
	type StorageWrite,
	type TaskId,
} from "../src/types.ts";
import { backend, commitAll, reads, sessionStore } from "./sync-support.ts";

const context = BACKGROUND_CONTEXT;
const SESSION = "session-1";
const directories: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function remote(): Promise<FileSystemSyncRemote> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-sync-"));
	directories.push(directory);
	return new FileSystemSyncRemote(new NodeExecutionEnv({ cwd: directory }), directory);
}

class MemoryState implements SyncStateStore {
	readonly states = new Map<string, SyncState>();
	async get(sessionId: string, _context: Context): Promise<SyncState | undefined> {
		return this.states.get(sessionId);
	}
	async set(sessionId: string, state: SyncState, _context: Context): Promise<void> {
		this.states.set(sessionId, state);
	}
}

/** `store` with some methods replaced: the remote keeps private fields, so the rest stay bound to it. */
function overriding(store: FileSystemSyncRemote, overrides: Partial<SessionSyncMaintenance>): SessionSyncMaintenance {
	return new Proxy(store, {
		get(target, property) {
			const own = (overrides as Record<PropertyKey, unknown>)[property];
			if (own !== undefined) return own;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

const tracked = (store: Store): Store => {
	stores.push(store);
	return store;
};

/**
 * One device with its copy of a session, which it continues as its own. A copy starts empty: its first pull restores
 * it into a fresh backend, or its first commit opens a store with an outbox.
 */
function device(name: string, remoteStore: FileSystemSyncRemote) {
	const state = new MemoryState();
	const copies = new Map<string, Store>();
	const self = {
		name,
		state,
		/** The copy's store, opened on first use. */
		async store(sessionId = SESSION): Promise<Store> {
			let store = copies.get(sessionId);
			if (store === undefined) {
				store = tracked(await sessionStore());
				copies.set(sessionId, store);
			}
			return store;
		},
		has: (sessionId = SESSION) => copies.has(sessionId),
		async commit(batches: readonly (readonly StorageWrite[])[], sessionId = SESSION): Promise<void> {
			await commitAll(await self.store(sessionId), batches);
		},
		async upload(sessionId = SESSION) {
			return uploadSession({
				sessionId,
				device: name,
				source: await self.store(sessionId),
				store: remoteStore,
				state,
				context,
			});
		},
		async pull(sessionId = SESSION): Promise<Seq> {
			const existing = copies.get(sessionId);
			const result = await pullSession({
				sessionId,
				store: remoteStore,
				local:
					existing === undefined
						? { kind: "empty", backend: await backend() }
						: { kind: "store", store: existing },
				state,
				context,
			});
			if (existing === undefined) copies.set(sessionId, tracked(result.store));
			return result.head;
		},
		/** Drops the copy, as a host does before restoring it fresh. */
		async forget(sessionId = SESSION): Promise<void> {
			const store = copies.get(sessionId);
			copies.delete(sessionId);
			await state.set(sessionId, { syncedHead: undefined }, context);
			if (store !== undefined) {
				stores.splice(stores.indexOf(store), 1);
				await store.close(context);
			}
		},
		/** Renames a copy: the new session id has no remote history, so no sync state either. */
		rename(from: string, to: string): void {
			const store = copies.get(from)!;
			copies.delete(from);
			copies.set(to, store);
			state.states.delete(from);
		},
	};
	return self;
}

const entryId = (id: number) => idFromNumber<EntryId>(id);
const documentId = (id: number) => idFromNumber<DocumentId>(id);
const entry = (id: number) =>
	({
		type: "entry",
		value: { id: entryId(id), conversationId: ROOT_CONVERSATION_ID, kind: "message", data: { id } },
	}) as const satisfies StorageWrite;
const sessionDoc = (id: number): DocumentCreate => ({
	id: documentId(id),
	kind: "test.session",
	scope: { kind: "session" },
});
const task = (id: number, status: "pending" | "running") =>
	({
		type: "task",
		value: {
			id: idFromNumber<TaskId<JsonValue>>(id),
			conversationId: ROOT_CONVERSATION_ID,
			kind: "test.task",
			version: 1,
			input: { id },
			background: false,
			abortRequested: false,
			state: { status, checkpoint: { status } },
		},
	}) as const satisfies StorageWrite;

/** Ten commits of entries, a task updated in place, and a session document with deltas and a new base. */
function seedBatches(): StorageWrite[][] {
	return [
		[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
		[entry(2), task(3, "pending")],
		[
			{
				type: "document.create",
				record: sessionDoc(4),
				content: { kind: "base", version: 1, value: { n: 0 } },
			},
		],
		[entry(5), task(3, "running")],
		[{ type: "document.change", id: documentId(4), content: { kind: "delta", version: 1, ops: [["s", ["n"], 1]] } }],
		[entry(6)],
		[{ type: "document.change", id: documentId(4), content: { kind: "base", version: 1, value: { n: 5 } } }],
		[entry(7)],
		[entry(8), task(9, "pending")],
		[entry(10)],
	];
}

const slot = (after: number, to: number, device: string): BatchInfo => ({
	after: seqFromNumber(after),
	to: seqFromNumber(to),
	device,
});

describe("batches", () => {
	it("round-trip outbox commits through gzip JSON lines", async () => {
		const store = tracked(await sessionStore());
		await commitAll(store, seedBatches());
		const commits = await readOutbox(store, LOG_START, 1000, context);
		expect(commits.length).toBeGreaterThan(0);
		const bytes = await encodeBatch(commits);
		expect(bytes[0]).toBe(0x1f);
		expect(await decodeBatch(bytes)).toEqual(commits);
	});
});

describe("remoteHistory", () => {
	const listing = {
		batches: [{ ...slot(0, 4, "a"), folded: true as const }, slot(4, 10, "a"), slot(10, 12, "b")],
		snapshots: [seqFromNumber(4)],
	};

	it("restores from the newest snapshot along the chain of slots", () => {
		expect(remoteHistory(listing)).toEqual({ snapshot: 4, batches: [slot(4, 10, "a"), slot(10, 12, "b")], head: 12 });
		expect(remoteHead(listing)).toBe(12);
		expect(remoteHistory({ batches: [], snapshots: [] })).toEqual({ batches: [], head: 0 });
	});

	it("continues a copy from its head, also from inside a batch", () => {
		expect(remoteHistory(listing, seqFromNumber(4))).toEqual({
			batches: [slot(4, 10, "a"), slot(10, 12, "b")],
			head: 12,
		});
		expect(remoteHistory(listing, seqFromNumber(7))).toEqual({
			batches: [slot(4, 10, "a"), slot(10, 12, "b")],
			head: 12,
		});
		expect(remoteHistory(listing, seqFromNumber(12))).toEqual({ batches: [], head: 12 });
	});
});

describe("syncing a session between devices", () => {
	it("uploads what was committed since the last upload, trims the outbox, and uploads nothing when nothing was", async () => {
		const store = await remote();
		const laptop = device("laptop", store);
		const batches = seedBatches();
		await laptop.commit(batches.slice(0, 4));
		const four = (await laptop.store()).lastSeq;
		expect(await laptop.upload()).toEqual({ type: "uploaded", head: four });
		expect((await laptop.store()).outbox!.floor).toBe(four);
		expect(await laptop.upload()).toEqual({ type: "idle" });
		await laptop.commit(batches.slice(4));
		const ten = (await laptop.store()).lastSeq;
		expect(await laptop.upload()).toEqual({ type: "uploaded", head: ten });
		expect((await store.list(SESSION, context)).batches).toEqual([
			slot(0, four, "laptop"),
			slot(four, ten, "laptop"),
		]);
	});

	it("hands a session back and forth: each device continues it as its own", async () => {
		const store = await remote();
		const laptop = device("laptop", store);
		const phone = device("phone", store);
		const batches = seedBatches();
		await laptop.commit(batches.slice(0, 5));
		await laptop.upload();

		expect(await phone.pull()).toBe((await laptop.store()).lastSeq);
		expect(await reads(await phone.store())).toEqual(await reads(await laptop.store()));
		await phone.commit(batches.slice(5, 7));
		expect((await phone.upload()).type).toBe("uploaded");

		await laptop.pull();
		expect(await reads(await laptop.store())).toEqual(await reads(await phone.store()));
		await laptop.commit(batches.slice(7));
		expect((await laptop.upload()).type).toBe("uploaded");
		await phone.pull();
		expect(await reads(await phone.store())).toEqual(await reads(await laptop.store()));
		expect((await store.list(SESSION, context)).batches.map((batch) => batch.device)).toEqual([
			"laptop",
			"phone",
			"laptop",
		]);
	});

	it("keeps a copy that only pulls in step, with nothing left to upload", async () => {
		const store = await remote();
		const laptop = device("laptop", store);
		const viewer = device("viewer", store);
		for (const writes of seedBatches()) {
			await laptop.commit([writes]);
			await laptop.upload();
			await viewer.pull();
		}
		expect(await reads(await viewer.store())).toEqual(await reads(await laptop.store()));
		expect(await viewer.upload()).toEqual({ type: "idle" });
	});

	for (const [first, second] of [
		["phone", "laptop"],
		["laptop", "phone"],
	] as const) {
		it(`lets the ${first} keep the session when both continued it and the ${first} uploaded first`, async () => {
			const store = await remote();
			const devices = { laptop: device("laptop", store), phone: device("phone", store) };
			const batches = seedBatches();
			await devices.laptop.commit(batches.slice(0, 5));
			await devices.laptop.upload();
			await devices.phone.pull();
			const shared = (await devices.laptop.store()).lastSeq;
			// Both continue without hearing from each other.
			await devices.laptop.commit(batches.slice(5, 7));
			await devices.phone.commit([[entry(100)]]);

			const winner = devices[first];
			const loser = devices[second];
			expect((await winner.upload()).type).toBe("uploaded");
			expect(await loser.upload()).toEqual({ type: "diverged", at: shared });
			await expect(loser.pull()).rejects.toThrow(UnsyncedCommitsError);

			// The loser's copy becomes a new session, uploaded whole as an archive (its outbox was trimmed through
			// `shared`); the session restores fresh on that device.
			loser.rename(SESSION, "fork-1");
			const forked = await loser.store("fork-1");
			expect(await loser.upload("fork-1")).toEqual({ type: "uploaded", head: forked.lastSeq });
			expect((await store.list("fork-1", context)).batches[0]).toMatchObject({ after: 0, archive: true });
			const fork = device(second, store);
			await fork.pull("fork-1");
			expect(await reads(await fork.store("fork-1"))).toEqual(await reads(forked));
			await loser.pull();
			expect(await reads(await loser.store())).toEqual(await reads(await winner.store()));
		});
	}

	it("goes on after an upload whose response was lost", async () => {
		const store = await remote();
		const laptop = device("laptop", store);
		const replica = device("replica", store);
		const batches = seedBatches();
		await laptop.commit(batches.slice(0, 5));
		await laptop.upload();
		const five = (await laptop.store()).lastSeq;
		await laptop.commit(batches.slice(5, 7));
		const seven = (await laptop.store()).lastSeq;
		// The remote creates the slot, but its response is lost: no sync state is written, nothing is trimmed.
		const lossy: SessionSyncMaintenance = overriding(store, {
			putBatch: async (...args: Parameters<FileSystemSyncRemote["putBatch"]>) => {
				await store.putBatch(...args);
				throw new Error("response lost");
			},
		});
		await expect(
			uploadSession({
				sessionId: SESSION,
				device: "laptop",
				source: await laptop.store(),
				store: lossy,
				state: laptop.state,
				context,
			}),
		).rejects.toThrow("response lost");
		expect(await laptop.state.get(SESSION, context)).toEqual({ syncedHead: five });
		await laptop.commit(batches.slice(7));
		const ten = (await laptop.store()).lastSeq;
		expect(await laptop.upload()).toEqual({ type: "uploaded", head: ten });
		expect((await store.list(SESSION, context)).batches).toEqual([
			slot(0, five, "laptop"),
			slot(five, seven, "laptop"),
			slot(seven, ten, "laptop"),
		]);
		await replica.pull();
		expect(await reads(await replica.store())).toEqual(await reads(await laptop.store()));
	});

	it("refuses to upload a copy that lost uploaded commits, and pulls them back", async () => {
		const store = await remote();
		const batches = seedBatches();
		const laptop = device("laptop", store);
		await laptop.commit(batches.slice(0, 7));
		await laptop.upload();
		const uploaded = (await laptop.store()).lastSeq;
		// A power loss kept only the first commits: a store that holds less than the sync state says.
		const survived = tracked(await sessionStore());
		await commitAll(survived, batches.slice(0, 5));
		const upload = () =>
			uploadSession({ sessionId: SESSION, device: "laptop", source: survived, store, state: laptop.state, context });
		expect(await upload()).toEqual({ type: "behind", head: survived.lastSeq, syncedHead: uploaded });

		await pullSession({
			sessionId: SESSION,
			store,
			local: { kind: "store", store: survived },
			state: laptop.state,
			context,
		});
		expect(await reads(survived)).toEqual(await reads(await laptop.store()));
		await commitAll(survived, batches.slice(7));
		expect((await upload()).type).toBe("uploaded");
	});

	it("creates slots only where the history ends", async () => {
		const store = await remote();
		const batches = seedBatches();
		const laptop = device("laptop", store);
		await laptop.commit(batches.slice(0, 5));
		await laptop.upload();
		const head = (await laptop.store()).lastSeq;
		// A copy that believes it shares 1 with the remote: no slot starts there, and the history ends further on.
		const desktop = device("desktop", store);
		await desktop.commit(batches.slice(0, 2));
		await desktop.state.set(SESSION, { syncedHead: seqFromNumber(1) }, context);
		const commits = await readOutbox(await desktop.store(), seqFromNumber(1), 100, context);
		expect(
			await store.putBatch(
				SESSION,
				seqFromNumber(1),
				seqFromNumber(commits.at(-1)!.seq),
				"desktop",
				await encodeBatch(commits),
				context,
			),
		).toEqual({ type: "not_head", head });
		expect(await desktop.upload()).toEqual({ type: "diverged", at: 1 });
		expect((await store.list(SESSION, context)).batches).toEqual([slot(0, head, "laptop")]);
	});

	it("resumes a pull that stopped inside a batch", async () => {
		const store = await remote();
		const laptop = device("laptop", store);
		await laptop.commit(seedBatches().slice(0, 3));
		await laptop.upload();
		await laptop.commit(seedBatches().slice(3));
		await laptop.upload();

		// The viewer applied the first batch, then lost the connection while reading the second.
		const viewer = device("viewer", store);
		const flaky: SessionSyncMaintenance = overriding(store, {
			getBatch: async (sessionId: string, after: Seq, ctx: Context) => {
				if (after > 0) throw new Error("connection lost");
				return store.getBatch(sessionId, after, ctx);
			},
		});
		const local = tracked(await openStore(await backend(), context, { outbox: true }));
		await expect(
			pullSession({
				sessionId: SESSION,
				store: flaky,
				local: { kind: "store", store: local },
				state: viewer.state,
				context,
			}),
		).rejects.toThrow("connection lost");
		expect(local.lastSeq).toBeGreaterThan(0);
		// The commits past what it shares are the remote's, not its own: nothing to upload, and the pull resumes.
		expect(
			await uploadSession({
				sessionId: SESSION,
				device: "viewer",
				source: local,
				store,
				state: viewer.state,
				context,
			}),
		).toEqual({ type: "idle" });
		await pullSession({
			sessionId: SESSION,
			store,
			local: { kind: "store", store: local },
			state: viewer.state,
			context,
		});
		expect(await reads(local)).toEqual(await reads(await laptop.store()));
	});

	it("folds the history into a snapshot that restores the session, and keeps its slots taken", async () => {
		const store = await remote();
		const laptop = device("laptop", store);
		const stale = device("stale", store);
		const replica = device("replica", store);
		for (const [index, writes] of seedBatches().entries()) {
			await laptop.commit([writes]);
			await laptop.upload();
			if (index === 3) await stale.pull();
		}
		const head = (await laptop.store()).lastSeq;
		expect(await foldSession({ sessionId: SESSION, store, scratch: await backend(), context })).toBe(head);
		expect((await store.list(SESSION, context)).snapshots).toEqual([head]);

		await replica.pull();
		expect(await reads(await replica.store())).toEqual(await reads(await laptop.store()));
		// A copy behind the fold cannot continue through folded batches: it restores instead.
		const at = (await stale.store()).lastSeq;
		await expect(stale.pull()).rejects.toThrow(HistoryUnavailableError);
		// Nor can it take a folded slot: its own commits are a different history.
		await stale.commit([[entry(300)]]);
		expect(await stale.upload()).toEqual({ type: "diverged", at });
		await stale.forget();
		await stale.pull();
		expect(await reads(await stale.store())).toEqual(await reads(await laptop.store()));

		// Uploads go on after the fold, and the replica follows them; so does a second fold and a fresh restore.
		await laptop.commit([[entry(100)], [entry(101)]]);
		await laptop.upload();
		await laptop.commit([[entry(102)]]);
		await laptop.upload();
		await replica.pull();
		expect(await reads(await replica.store())).toEqual(await reads(await laptop.store()));
		expect(await foldSession({ sessionId: SESSION, store, scratch: await backend(), context })).toBe(
			(await laptop.store()).lastSeq,
		);
		const restored = device("restored", store);
		await restored.pull();
		expect(await reads(await restored.store())).toEqual(await reads(await laptop.store()));
	});

	it("reports a batch that vanished while folding", async () => {
		const store = await remote();
		const laptop = device("laptop", store);
		for (const writes of seedBatches().slice(0, 3)) {
			await laptop.commit([writes]);
			await laptop.upload();
		}
		const vanishing: SessionSyncMaintenance = overriding(store, {
			getBatch: async () => undefined,
		});
		await expect(
			foldSession({ sessionId: SESSION, store: vanishing, scratch: await backend(), context }),
		).rejects.toThrow(HistoryUnavailableError);
	});

	it("refuses a store without an outbox", async () => {
		const store = await remote();
		const plain = tracked(await openStore(await backend(), context));
		await expect(
			uploadSession({
				sessionId: SESSION,
				device: "laptop",
				source: plain,
				store,
				state: new MemoryState(),
				context,
			}),
		).rejects.toThrow(OutboxUnavailableError);
	});

	it("uploads an archive first for a session whose outbox was turned on late", async () => {
		const store = await remote();
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-sync-late-"));
		directories.push(directory);
		const file = join(directory, "session.sqlite");
		const before = await openStore(await backend(file), context);
		await commitAll(before, seedBatches().slice(0, 4));
		await before.close(context);
		// Reopening with the outbox turns it on from the current head: the earlier commits are not in it.
		const source = tracked(await openStore(await backend(file), context, { outbox: true }));
		expect(source.outbox!.floor).toBe(source.lastSeq);
		await commitAll(source, seedBatches().slice(4));
		const state = new MemoryState();
		expect(await uploadSession({ sessionId: SESSION, device: "laptop", source, store, state, context })).toEqual({
			type: "uploaded",
			head: source.lastSeq,
		});
		expect((await store.list(SESSION, context)).batches).toEqual([
			{ ...slot(0, source.lastSeq, "laptop"), archive: true },
		]);
		const replica = device("replica", store);
		await replica.pull();
		expect(await reads(await replica.store())).toEqual(await reads(source));
	});
});

describe("host pieces", () => {
	it("lists sessions and keeps the last metadata written", async () => {
		const store = await remote();
		expect(await store.sessions(undefined, context)).toEqual({ sessions: [], cursor: "", more: false });
		const laptop = device("laptop", store);
		await laptop.commit([[entry(1)]], "s2");
		await laptop.upload("s2");
		await store.putMeta("s1", { title: "first" }, context);
		await store.putMeta("s1", { title: "renamed", origin: "laptop" }, context);
		expect((await store.sessions(undefined, context)).sessions).toEqual([
			{ id: "s1", head: LOG_START, meta: { title: "renamed", origin: "laptop" } },
			{ id: "s2", head: (await laptop.store("s2")).lastSeq, meta: undefined },
		]);
		expect(await store.getMeta("s1", context)).toEqual({ title: "renamed", origin: "laptop" });
		expect(await store.getMeta("s2", context)).toBeUndefined();
	});

	it("refuses session IDs that leave the root", async () => {
		const store = await remote();
		for (const id of ["..", "../x", "a/b", "", ".hidden"]) {
			await expect(store.list(id, context)).rejects.toThrow("Invalid session ID");
		}
	});

	it("keeps sync state in files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-sync-state-"));
		directories.push(directory);
		const state = new FileSyncStateStore(new NodeExecutionEnv({ cwd: directory }), join(directory, "sync"));
		expect(await state.get(SESSION, context)).toBeUndefined();
		await state.set(SESSION, { syncedHead: seqFromNumber(3), pulling: seqFromNumber(7) }, context);
		expect(await state.get(SESSION, context)).toEqual({ syncedHead: seqFromNumber(3), pulling: seqFromNumber(7) });
		await state.set(SESSION, { syncedHead: undefined }, context);
		expect(await state.get(SESSION, context)).toEqual({ syncedHead: undefined });
		await state.delete(SESSION, context);
		expect(await state.get(SESSION, context)).toBeUndefined();
	});
});

describe("FlushScheduler", () => {
	function clock() {
		let now = 0;
		const timers: { at: number; callback: () => void; armed: boolean }[] = [];
		return {
			now: () => now,
			setTimer: (callback: () => void, delayMs: number) => {
				const timer = { at: now + delayMs, callback, armed: true };
				timers.push(timer);
				return () => {
					timer.armed = false;
				};
			},
			/** Fire due timers at their own times, letting each callback's promises settle before the next. */
			async advance(ms: number) {
				const end = now + ms;
				while (true) {
					const next = timers.filter((item) => item.armed && item.at <= end).sort((a, b) => a.at - b.at)[0];
					if (next === undefined) break;
					now = next.at;
					next.armed = false;
					next.callback();
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				now = end;
			},
		};
	}

	it("flushes some time after a commit, sooner after an urgent one, once per window", async () => {
		const time = clock();
		const flushes: number[] = [];
		const scheduler = new FlushScheduler({
			...time,
			flush: async () => void flushes.push(time.now()),
			onError: (error) => {
				throw error;
			},
		});
		scheduler.notify(false);
		scheduler.notify(false);
		await time.advance(4000);
		expect(flushes).toEqual([]);
		scheduler.notify(true);
		await time.advance(200);
		expect(flushes).toEqual([4200]);
		await time.advance(5000);
		expect(flushes).toEqual([4200]);
		await scheduler.close();
		expect(flushes).toEqual([4200, 9200]);
	});

	it("keeps the urgency of commits that arrived during a flush", async () => {
		const time = clock();
		let release: () => void = () => {};
		const flushes: number[] = [];
		const scheduler = new FlushScheduler({
			...time,
			flush: () => {
				flushes.push(time.now());
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			onError: (error) => {
				throw error;
			},
		});
		scheduler.notify(false);
		await time.advance(5000);
		scheduler.notify(false);
		scheduler.notify(true);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await time.advance(200);
		expect(flushes).toEqual([5000, 5200]);
	});

	it("retries a failed flush with backoff until it succeeds, without another commit", async () => {
		const time = clock();
		const attempts: number[] = [];
		const errors: unknown[] = [];
		const scheduler = new FlushScheduler({
			...time,
			flush: async () => {
				attempts.push(time.now());
				if (attempts.length < 3) throw new Error("offline");
			},
			onError: (error) => errors.push(error),
		});
		scheduler.notify(true);
		await time.advance(5000);
		expect(attempts).toEqual([200, 1200, 3200]);
		expect(errors).toHaveLength(2);
		await time.advance(60_000);
		expect(attempts).toHaveLength(3);
	});

	it("marks commits with input, answers, or settled submissions as urgent", () => {
		const publication = (changes: CommitPublication["changes"]): CommitPublication => ({
			seq: seqFromNumber(1) as Seq,
			changes,
		});
		expect(
			isUrgentCommit(
				publication([{ type: "entry", value: { id: 1, conversationId: 1, kind: "pi.user" } }] as never),
			),
		).toBe(true);
		expect(isUrgentCommit(publication([{ type: "entry", value: entry(1).value }] as never))).toBe(false);
	});
});
