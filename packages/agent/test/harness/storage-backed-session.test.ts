import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import type { CustomMessage } from "../../src/harness/messages.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { GatingStorage, InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type {
	MessageEntry,
	NewEntry,
	Session,
	SessionMetadata,
	SessionMutator,
	Write,
} from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";
import { deferred } from "./runtime/test-utils.ts";

const NOW = 1_700_000_000_000;
const ENTRY_ID = "00000000-0000-7000-8000-000000000001";
const metadata = {
	id: "session",
	createdAt: NOW,
	storageVersion: 1,
	cwd: "/workspace",
} satisfies SessionMetadata;

function commitSession(session: Session, transaction: Write[]) {
	return session.mutate((mutator) => mutator.commit(transaction, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
}

describe("StorageBackedSession", () => {
	it("delegates typed values directly without validation or cloning", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const data = { nested: ["original"] };
		const transaction: Write[] = [
			sessionWrites.insertEntry({ id: ENTRY_ID, parentId: null, type: "custom", customType: "note", data }),
			storedValues.setValue(storedValues.value<unknown>("test.value", "state"), data),
		];

		const result = await commitSession(session, transaction);

		expect(storage.getCommitAttempts()[0]).toBe(transaction);
		const entry = (await session.getEntries([ENTRY_ID], BACKGROUND_CONTEXT)).get(ENTRY_ID);
		expect(entry).toMatchObject({ seq: result.seqs[0], timestamp: NOW });
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.data).toBe(data);
		expect(
			(await session.getValue(storedValues.value<unknown>("test.value", "state"), BACKGROUND_CONTEXT))?.value,
		).toBe(data);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("composes bound values and lists atomically with entries and usage", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const scalar = storedValues.value<string>("test.application.scalar");
		const events = storedValues.list<string>("test.application.events");

		const result = await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						sessionWrites.insertEntry({ id: ENTRY_ID, parentId: null, type: "custom", customType: "note" }),
						storedValues.setValue(scalar, "state"),
						storedValues.appendList(events, "event"),
						sessionWrites.insertUsage({
							id: "usage",
							adjustment: false,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		expect(result.seqs).toHaveLength(4);
		expect((await session.getValue(scalar, BACKGROUND_CONTEXT))?.seq).toBe(result.seqs[1]);
		expect(await session.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([
			{ seq: result.seqs[2], value: "event" },
		]);
		expect(storage.getCommitAttempts()).toHaveLength(1);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("serializes read-modify-write callbacks on the single Session line", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		const counter = storedValues.value<number>("test.counter");
		const increment = () =>
			session.mutate(async (mutator) => {
				const next = ((await mutator.getValue(counter, BACKGROUND_CONTEXT))?.value ?? 0) + 1;
				await mutator.commit([storedValues.setValue(counter, next)], BACKGROUND_CONTEXT);
				return next;
			}, BACKGROUND_CONTEXT);

		await expect(Promise.all([increment(), increment()])).resolves.toEqual([1, 2]);
		expect((await session.getValue(counter, BACKGROUND_CONTEXT))?.value).toBe(2);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("keeps separate direct reads and writes deliberately non-atomic", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		const counter = storedValues.value<number>("test.counter");
		const bothRead = deferred();
		let readers = 0;
		const increment = async () => {
			const next = ((await session.getValue(counter, BACKGROUND_CONTEXT))?.value ?? 0) + 1;
			readers++;
			if (readers === 2) bothRead.resolve();
			await bothRead.promise;
			await session.setValue(counter, next, BACKGROUND_CONTEXT);
		};

		await Promise.all([increment(), increment()]);
		expect((await session.getValue(counter, BACKGROUND_CONTEXT))?.value).toBe(1);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("queues a nested public writer until its owning callback returns", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		let nested: Promise<void> | undefined;
		await session.mutate(async () => {
			nested = session.setValue(storedValues.sessionName, "nested", BACKGROUND_CONTEXT);
			let settled = false;
			void nested.finally(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
		}, BACKGROUND_CONTEXT);
		if (nested === undefined) throw new Error("Expected nested writer");
		await nested;
		expect(await session.getName(BACKGROUND_CONTEXT)).toBe("nested");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("exposes either side of an atomic multi-write commit to direct reads", async () => {
		const first = storedValues.value<string>("test.atomic", "first");
		const second = storedValues.value<string>("test.atomic", "second");
		const storage = new GatingStorage(new MemoryStorage({ now: () => NOW }));
		await storage.commit(
			[storedValues.setValue(first, "old"), storedValues.setValue(second, "old")],
			BACKGROUND_CONTEXT,
		);
		storage.arm();
		const session = new StorageBackedSession(metadata, storage);
		const committing = commitSession(session, [
			storedValues.setValue(first, "new"),
			storedValues.setValue(second, "new"),
		]);
		await storage.waitPending();

		expect((await session.getValue(first, BACKGROUND_CONTEXT))?.value).toBe("old");
		expect((await session.getValue(second, BACKGROUND_CONTEXT))?.value).toBe("old");
		await storage.next();
		await committing;
		expect((await session.getValue(first, BACKGROUND_CONTEXT))?.value).toBe("new");
		expect((await session.getValue(second, BACKGROUND_CONTEXT))?.value).toBe("new");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("holds the explicit Session barrier through commit until end", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
		let queuedStarted = false;
		const queued = session.mutate(() => {
			queuedStarted = true;
		}, BACKGROUND_CONTEXT);

		await Promise.resolve();
		expect(queuedStarted).toBe(false);
		expect(await mutation.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeUndefined();
		const result = await mutation.commit([], BACKGROUND_CONTEXT);
		expect(result.seqs).toEqual([]);
		expect(queuedStarted).toBe(false);
		expect(await mutation.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeUndefined();
		await mutation.end(BACKGROUND_CONTEXT);
		await queued;
		expect(queuedStarted).toBe(true);
		expect(storage.getCommitAttempts()).toEqual([[]]);
		expect(() => mutation.getEntries([], BACKGROUND_CONTEXT)).toThrow("outside its mutation callback");
		expect(() => mutation.commit([], BACKGROUND_CONTEXT)).toThrow("outside its mutation callback");
		await expect(mutation.end(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("allows direct reads to observe a committed value before the mutation scope ends", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
		expect(await session.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeUndefined();
		await mutation.commit([storedValues.setValue(storedValues.sessionName, "visible")], BACKGROUND_CONTEXT);
		let queuedStarted = false;
		const queued = session.mutate(() => {
			queuedStarted = true;
		}, BACKGROUND_CONTEXT);

		expect((await session.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("visible");
		expect(queuedStarted).toBe(false);
		await mutation.end(BACKGROUND_CONTEXT);
		await queued;
		expect(queuedStarted).toBe(true);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("ends an explicit mutation without committing and lets close finish", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
		let closed = false;
		const closing = session.close(BACKGROUND_CONTEXT).then(() => {
			closed = true;
		});

		await Promise.resolve();
		expect(closed).toBe(false);
		await mutation.end(BACKGROUND_CONTEXT);
		await closing;
		expect(closed).toBe(true);
		expect(storage.getCommitAttempts()).toEqual([]);
	});

	it("exposes explicit branch scans through the Session and callback-scoped mutator", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);
		const childId = "00000000-0000-7000-8000-000000000002";
		await commitSession(session, [
			sessionWrites.insertEntry({ id: ENTRY_ID, parentId: null, type: "custom", customType: "root" }),
			sessionWrites.insertEntry({ id: childId, parentId: ENTRY_ID, type: "custom", customType: "child" }),
		]);

		await expect(
			session.scanBranch({ start: childId, order: "oldestFirst" }, BACKGROUND_CONTEXT),
		).resolves.toMatchObject([{ id: ENTRY_ID }, { id: childId }]);
		let captured: SessionMutator | undefined;
		await session.mutate(async (mutator) => {
			captured = mutator;
			await expect(mutator.scanBranch({ start: childId, limit: 1 }, BACKGROUND_CONTEXT)).resolves.toMatchObject([
				{ id: childId },
			]);
		}, BACKGROUND_CONTEXT);
		const invalidated = captured;
		if (invalidated === undefined) throw new Error("Expected captured mutator");
		expect(() => invalidated.scanBranch({ start: childId }, BACKGROUND_CONTEXT)).toThrow(
			"outside its mutation callback",
		);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("rejects pending assistant entries at the durable session write boundary", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const pending: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: NOW,
		};

		await expect(
			commitSession(session, [
				sessionWrites.insertEntry({ id: ENTRY_ID, parentId: null, type: "message", message: pending }),
			]),
		).rejects.toThrow("Cannot persist a pending assistant message");
		expect(storage.getCommitAttempts()).toEqual([]);
		expect(await session.getEntries([ENTRY_ID], BACKGROUND_CONTEXT)).toEqual(new Map());
		await session.close(BACKGROUND_CONTEXT);
	});

	it("trusts typed custom messages without repository schema registration", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);
		const message: CustomMessage = {
			role: "custom",
			customType: "notice",
			content: "maintenance",
			display: true,
			timestamp: NOW,
		};
		const entry: NewEntry<MessageEntry> = { id: ENTRY_ID, parentId: null, type: "message", message };

		const result = await commitSession(session, [sessionWrites.insertEntry(entry)]);

		expect((await session.getEntries([ENTRY_ID], BACKGROUND_CONTEXT)).get(ENTRY_ID)).toEqual({
			...entry,
			seq: result.firstSeq,
			timestamp: result.timestamp,
		});
		await session.close(BACKGROUND_CONTEXT);
	});

	it("serializes mutations, permits one commit attempt, and invalidates the mutator", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		let captured: SessionMutator | undefined;

		await session.mutate(async (mutator) => {
			captured = mutator;
			expect(await mutator.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeUndefined();
			await mutator.commit([storedValues.setValue(storedValues.sessionName, "committed")], BACKGROUND_CONTEXT);
			await expect(mutator.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("commit already attempted");
		}, BACKGROUND_CONTEXT);

		expect(storage.getCommitAttempts()).toHaveLength(1);
		expect(await session.getName(BACKGROUND_CONTEXT)).toBe("committed");
		const invalidated = captured;
		if (invalidated === undefined) throw new Error("Expected captured mutator");
		expect(() => invalidated.getEntries([], BACKGROUND_CONTEXT)).toThrow("outside its mutation callback");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("consumes the commit guard when the first commit fails", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const transaction = [
			sessionWrites.insertEntry({ id: ENTRY_ID, parentId: "missing", type: "custom", customType: "note" }),
		] satisfies Write[];

		await expect(
			session.mutate(async (mutator) => {
				await expect(mutator.commit(transaction, BACKGROUND_CONTEXT)).rejects.toThrow("Missing parent entry");
				await expect(mutator.commit([], BACKGROUND_CONTEXT)).rejects.toThrow("commit already attempted");
			}, BACKGROUND_CONTEXT),
		).resolves.toBeUndefined();
		expect(storage.getCommitAttempts()).toHaveLength(1);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("mints distinct follower ids with the leader timestamp", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		const leaderTimestamp = 0x0123456789ab;
		const leader = session.idGenerator.next(leaderTimestamp);
		const followers = [session.idGenerator.next(leaderTimestamp), session.idGenerator.next(leaderTimestamp)];
		const decodeTimestamp = (id: string): number => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

		expect([leader, ...followers].map(decodeTimestamp)).toEqual([leaderTimestamp, leaderTimestamp, leaderTimestamp]);
		expect(new Set([leader, ...followers])).toHaveLength(3);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("accepts an injected id generator for deterministic execution tests", async () => {
		let next = 0;
		const idGenerator = { next: (timestampMs?: number) => `${timestampMs ?? "now"}:${++next}` };
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }), { idGenerator });

		expect(session.idGenerator).toBe(idGenerator);
		expect(session.idGenerator.next(7)).toBe("7:1");
		expect(session.idGenerator.next()).toBe("now:2");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("exposes metadata directly and the shared UUIDv7 id generator", async () => {
		const sourceMetadata = { ...metadata };
		const session = new StorageBackedSession(sourceMetadata, new MemoryStorage({ now: () => NOW }));

		expect(session.metadata).toBe(sourceMetadata);
		expect(session.idGenerator.next()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("closes idempotently and rejects operations not admitted before close", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);

		await Promise.all([session.close(BACKGROUND_CONTEXT), session.close(BACKGROUND_CONTEXT)]);
		await expect(session.mutate(() => undefined, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		await expect(session.getEntries([], BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		await expect(session.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		await expect(session.scanValues(storedValues.sessionName, BACKGROUND_CONTEXT)).rejects.toThrow(
			"Session is closed",
		);
		await expect(session.scanBranch({ start: ENTRY_ID }, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
	});
});
