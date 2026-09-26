import type { Op } from "@earendil-works/chord/delta";
import {
	defineDoc,
	defineDocFamily,
	type EntryId,
	type JsonObject,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context, createConversation, documentChanges, flush, openTestSession } from "./session-support.ts";

function documentWrites(writes: readonly StorageWrite[]): readonly StorageWrite[] {
	return writes.filter(
		(write) =>
			write.type === "document.create" || write.type === "document.change" || write.type === "document.retire",
	);
}

describe("Session document checkpoints", () => {
	it("selects bases only for nonempty ordinary batches and passes the exact prepared revision and ops", async () => {
		const calls: { value: Readonly<JsonObject>; ops: readonly Op[] }[] = [];
		const falseCalls: { value: Readonly<JsonObject>; ops: readonly Op[] }[] = [];
		const BaseDoc = defineDoc<{ items: string[] }>({
			kind: "checkpoint.base",
			version: 1,
			scope: "session",
			initial: () => ({ items: [] }),
			checkpointWhen: (value, ops) => {
				calls.push({ value, ops });
				return true;
			},
		});
		const DeltaDoc = defineDoc<{ count: number }>({
			kind: "checkpoint.delta",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
			checkpointWhen: (value, ops) => {
				falseCalls.push({ value, ops });
				return false;
			},
		});
		const DefaultDoc = defineDoc<{ count: number }>({
			kind: "checkpoint.default",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
		});
		const { session, storage, publications } = openTestSession();

		await session.commit(async (tx) => {
			await tx.doc(BaseDoc);
			await tx.doc(DeltaDoc);
			await tx.doc(DefaultDoc);
		}, context);
		expect(calls).toHaveLength(0);
		expect(falseCalls).toHaveLength(0);
		expect(documentWrites(storage.commits.at(-1)!)).toSatisfy((writes: readonly StorageWrite[]) =>
			writes.every((write) => write.type === "document.create" && write.content.kind === "base"),
		);

		await session.commit(async (tx) => {
			(await tx.doc(BaseDoc)).items.push("x");
			(await tx.doc(DeltaDoc)).count++;
			(await tx.doc(DefaultDoc)).count++;
		}, context);
		await flush();
		const writes = storage.admittedCommits.at(-1)!.filter((write) => write.type === "document.change");
		expect(writes.map((write) => write.content.kind)).toEqual(["base", "delta", "delta"]);
		expect(calls).toHaveLength(1);
		expect(falseCalls).toHaveLength(1);
		const snapshot = (await session.snapshot(BaseDoc, context))!;
		const deltaSnapshot = (await session.snapshot(DeltaDoc, context))!;
		const [published, publishedDelta] = documentChanges(publications.at(-1)!);
		expect(calls[0]!.value).toBe(snapshot);
		expect(calls[0]!.ops).toBe(published!.ops);
		expect(falseCalls[0]!.value).toBe(deltaSnapshot);
		expect(falseCalls[0]!.ops).toBe(publishedDelta!.ops);
		if (writes[1]!.type !== "document.change" || writes[1]!.content.kind !== "delta") {
			throw new Error("Expected ordinary delta");
		}
		expect(writes[1]!.content.ops).toBe(falseCalls[0]!.ops);
		expect(writes[0]!.type).toBe("document.change");
		if (writes[0]!.type !== "document.change" || writes[0]!.content.kind !== "base") {
			throw new Error("Expected checkpoint base");
		}
		expect(writes[0]!.content.value).toBe(snapshot);
	});

	it("skips the predicate for empty batches but calls it for nonempty structural no-ops", async () => {
		let calls = 0;
		const Doc = defineDoc<{ items: string[] }>({
			kind: "checkpoint.no-op",
			version: 1,
			scope: "session",
			initial: () => ({ items: ["a", "b"] }),
			checkpointWhen: () => {
				calls++;
				return false;
			},
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Doc).then(() => undefined), context);
		const commits = storage.commits.length;

		await session.commit(async (tx) => {
			const value = await tx.doc(Doc);
			value.items.push("x");
			value.items.pop();
		}, context);
		expect(calls).toBe(0);
		expect(storage.commits).toHaveLength(commits);

		await session.commit(async (tx) => {
			const value = await tx.doc(Doc);
			const first = value.items.shift()!;
			value.items.unshift(first);
		}, context);
		expect(calls).toBe(1);
		expect(storage.commits.at(-1)![0]).toMatchObject({
			type: "document.change",
			content: { kind: "delta" },
		});
	});

	it("rolls back every prepared document when a checkpoint predicate throws", async () => {
		let throwCheckpoint = true;
		let firstCalls = 0;
		const First = defineDoc<{ count: number }>({
			kind: "checkpoint.rollback.first",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
			checkpointWhen: () => {
				firstCalls++;
				return false;
			},
		});
		const Second = defineDoc<{ count: number }>({
			kind: "checkpoint.rollback.second",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
			checkpointWhen: () => {
				if (throwCheckpoint) throw new Error("checkpoint failed");
				return false;
			},
		});
		const { session, storage, publications } = openTestSession();
		await session.commit(async (tx) => {
			await tx.doc(First);
			await tx.doc(Second);
		}, context);
		await flush();
		const first = (await session.snapshot(First, context))!;
		const second = (await session.snapshot(Second, context))!;
		const commits = storage.commits.length;
		const published = publications.length;

		await expect(
			session.commit(async (tx) => {
				(await tx.doc(First)).count = 1;
				(await tx.doc(Second)).count = 2;
			}, context),
		).rejects.toThrow("checkpoint failed");
		await flush();
		expect(firstCalls).toBe(1);
		expect(storage.commits).toHaveLength(commits);
		expect(publications).toHaveLength(published);
		expect(await session.snapshot(First, context)).toBe(first);
		expect(await session.snapshot(Second, context)).toBe(second);

		throwCheckpoint = false;
		await session.commit(async (tx) => {
			(await tx.doc(First)).count = 3;
			(await tx.doc(Second)).count = 4;
		}, context);
		expect(await session.snapshot(First, context)).toEqual({ count: 3 });
		expect(await session.snapshot(Second, context)).toEqual({ count: 4 });
	});

	it("persists repeated false decisions as deltas and replays the complete tail", async () => {
		let calls = 0;
		const Doc = defineDoc<{ values: number[] }>({
			kind: "checkpoint.tail",
			version: 1,
			scope: "session",
			initial: () => ({ values: [] }),
			checkpointWhen: () => {
				calls++;
				return false;
			},
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Doc).then(() => undefined), context);
		for (let value = 1; value <= 8; value++) {
			await session.commit(async (tx) => {
				(await tx.doc(Doc)).values.push(value);
			}, context);
		}
		const changes = storage.commits.flat().filter((write) => write.type === "document.change");
		expect(changes).toHaveLength(8);
		expect(changes.every((write) => write.content.kind === "delta")).toBe(true);
		expect(calls).toBe(8);
		await session.unloadDocuments();
		expect(await session.snapshot(Doc, context)).toEqual({ values: [1, 2, 3, 4, 5, 6, 7, 8] });
	});

	it("keeps a prepared root replacement as a delta when the predicate is false", async () => {
		const initial: Record<string, number> = {};
		for (let index = 0; index < 4_100; index++) initial[`field${index}`] = 0;
		const Doc = defineDoc<Record<string, number>>({
			kind: "checkpoint.root-replacement",
			version: 1,
			scope: "session",
			initial: () => initial,
			checkpointWhen: () => false,
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Doc).then(() => undefined), context);
		await session.commit(async (tx) => {
			const value = await tx.doc(Doc);
			for (let index = 0; index < 4_100; index++) value[`field${index}`] = 1;
		}, context);
		const write = storage.commits.at(-1)![0]!;
		expect(write.type).toBe("document.change");
		if (write.type !== "document.change" || write.content.kind !== "delta") {
			throw new Error("Expected root replacement delta");
		}
		expect(write.content.ops).toHaveLength(1);
		expect(write.content.ops[0]![0]).toBe("r");
		await session.unloadDocuments();
		expect((await session.snapshot(Doc, context))!.field4099).toBe(1);
	});

	it("uses ordinary checkpoint selection before retirement", async () => {
		let calls = 0;
		const Doc = defineDoc<{ count: number }>({
			kind: "checkpoint.retire",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
			checkpointWhen: () => {
				calls++;
				return true;
			},
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Doc).then(() => undefined), context);
		await session.commit(async (tx) => {
			(await tx.doc(Doc)).count = 1;
			await tx.retireDoc(Doc);
		}, context);
		expect(calls).toBe(1);
		expect(documentWrites(storage.commits.at(-1)!)).toEqual([
			expect.objectContaining({ type: "document.change", content: expect.objectContaining({ kind: "base" }) }),
			expect.objectContaining({ type: "document.retire" }),
		]);
	});
});

describe("Session document migrations", () => {
	it("migrates read-only once per cold load, copies the callback result, and writes nothing", async () => {
		type Current = { count: number; labels: string[] };
		const Old = defineDoc<{ count: number }>({
			kind: "migration.read-only",
			version: 1,
			scope: "session",
			initial: () => ({ count: 2 }),
		});
		let calls = 0;
		let retained: Current | undefined;
		const Current = defineDoc<Current>({
			kind: "migration.read-only",
			version: 3,
			scope: "session",
			initial: () => ({ count: 0, labels: [] }),
			migrate: (value, fromVersion) => {
				expect(fromVersion).toBe(1);
				calls++;
				retained = { count: value.count as number, labels: ["migrated"] };
				return retained;
			},
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		const commits = storage.commits.length;

		const first = (await session.snapshot(Current, context))!;
		expect(await session.snapshot(Current, context)).toBe(first);
		expect(calls).toBe(1);
		expect(storage.commits).toHaveLength(commits);
		retained!.count = 99;
		retained!.labels.push("mutated");
		expect(first).toEqual({ count: 2, labels: ["migrated"] });

		await session.unloadDocuments();
		const second = (await session.snapshot(Current, context))!;
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
		expect(calls).toBe(2);
		expect(storage.commits).toHaveLength(commits);
	});

	it("writes the required base on the first successful transaction, then writes deltas", async () => {
		const Old = defineDoc<{ count: number }>({
			kind: "migration.transition",
			version: 1,
			scope: "session",
			initial: () => ({ count: 4 }),
		});
		let checkpoints = 0;
		const Current = defineDoc<{ count: number }>({
			kind: "migration.transition",
			version: 3,
			scope: "session",
			initial: () => ({ count: 0 }),
			migrate: (value, fromVersion) => ({ count: (value.count as number) + fromVersion - 1 }),
			checkpointWhen: () => {
				checkpoints++;
				return false;
			},
		});
		const { session, storage, publications } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		expect(await session.snapshot(Current, context)).toEqual({ count: 4 });
		const snapshot = await session.snapshot(Current, context);

		await session.commit((tx) => tx.doc(Current).then(() => undefined), context);
		await flush();
		expect(storage.commits.at(-1)![0]).toMatchObject({
			type: "document.change",
			content: { kind: "base", version: 3, value: { count: 4 } },
		});
		expect(checkpoints).toBe(0);
		expect(documentChanges(publications.at(-1)!)).toHaveLength(0);
		expect(await session.snapshot(Current, context)).toBe(snapshot);

		await session.commit(async (tx) => {
			(await tx.doc(Current)).count = 7;
		}, context);
		expect(storage.commits.at(-1)![0]).toMatchObject({
			type: "document.change",
			content: { kind: "delta", version: 3 },
		});
		expect(checkpoints).toBe(1);
		await session.unloadDocuments();
		expect(await session.snapshot(Current, context)).toEqual({ count: 7 });
	});

	it("rolls migration and edits back with the callback, then coalesces later edits into one base", async () => {
		const Old = defineDoc<{ count: number }>({
			kind: "migration.rollback",
			version: 1,
			scope: "session",
			initial: () => ({ count: 1 }),
		});
		let migrations = 0;
		const Current = defineDoc<{ count: number; migrated: boolean }>({
			kind: "migration.rollback",
			version: 2,
			scope: "session",
			initial: () => ({ count: 0, migrated: false }),
			migrate: (value) => {
				migrations++;
				return { count: value.count as number, migrated: true };
			},
		});
		const { session, storage, publications } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		const commits = storage.commits.length;

		await expect(
			session.commit(async (tx) => {
				(await tx.doc(Current)).count = 8;
				throw new Error("rollback");
			}, context),
		).rejects.toThrow("rollback");
		expect(storage.commits).toHaveLength(commits);
		expect(await session.snapshot(Current, context)).toEqual({ count: 1, migrated: true });
		expect(migrations).toBe(1);

		await session.commit(async (tx) => {
			const value = await tx.doc(Current);
			value.count = 9;
			value.migrated = false;
		}, context);
		expect(documentWrites(storage.commits.at(-1)!)).toEqual([
			expect.objectContaining({
				type: "document.change",
				content: { kind: "base", version: 2, value: { count: 9, migrated: false } },
			}),
		]);
		await flush();
		const published = documentChanges(publications.at(-1)!)[0]!;
		const admitted = storage.admittedCommits.at(-1)![0]!;
		if (admitted.type !== "document.change" || admitted.content.kind !== "base") {
			throw new Error("Expected migration base");
		}
		expect(published.value).toBe(await session.snapshot(Current, context));
		expect(published.value).toBe(admitted.content.value);
		expect(published.ops.length).toBeGreaterThan(0);
		expect(migrations).toBe(1);
	});

	it("strict-checks migration results before tracker ownership and remains usable after rejection", async () => {
		const Old = defineDoc<{ count: number }>({
			kind: "migration.invalid",
			version: 1,
			scope: "session",
			initial: () => ({ count: 1 }),
		});
		const Invalid = defineDoc<JsonObject>({
			kind: "migration.invalid",
			version: 2,
			scope: "session",
			initial: () => ({}),
			migrate: () => ({ invalid: new Date() }) as unknown as JsonObject,
		});
		const Other = defineDoc<{ ok: boolean }>({
			kind: "migration.invalid.other",
			version: 1,
			scope: "session",
			initial: () => ({ ok: true }),
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		const commits = storage.commits.length;
		await expect(session.snapshot(Invalid, context)).rejects.toThrow("strict JSON");
		await expect(session.commit((tx) => tx.doc(Invalid).then(() => undefined), context)).rejects.toThrow(
			"strict JSON",
		);
		expect(storage.commits).toHaveLength(commits);
		await session.commit((tx) => tx.doc(Other).then(() => undefined), context);
		expect(await session.snapshot(Other, context)).toEqual({ ok: true });
	});

	it("rejects newer stored versions and older versions without migration for snapshots and transactions", async () => {
		const V2 = defineDoc<{ count: number }>({
			kind: "migration.compatibility",
			version: 2,
			scope: "session",
			initial: () => ({ count: 2 }),
		});
		const V1 = defineDoc<{ count: number }>({
			kind: "migration.compatibility",
			version: 1,
			scope: "session",
			initial: () => ({ count: 1 }),
		});
		const V3WithoutMigration = defineDoc<{ count: number }>({
			kind: "migration.compatibility",
			version: 3,
			scope: "session",
			initial: () => ({ count: 3 }),
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(V2).then(() => undefined), context);
		await session.unloadDocuments();
		const commits = storage.commits.length;

		await expect(session.snapshot(V1, context)).rejects.toThrow("newer version 2 than 1");
		await expect(session.commit((tx) => tx.doc(V1).then(() => undefined), context)).rejects.toThrow(
			"newer version 2 than 1",
		);
		await expect(session.snapshot(V3WithoutMigration, context)).rejects.toThrow("requires migration from version 2");
		await expect(session.commit((tx) => tx.doc(V3WithoutMigration).then(() => undefined), context)).rejects.toThrow(
			"requires migration from version 2",
		);
		expect(storage.commits).toHaveLength(commits);
	});

	it("persists a required migration base before retirement without consulting the checkpoint predicate", async () => {
		const Old = defineDoc<{ count: number }>({
			kind: "migration.retire",
			version: 1,
			scope: "session",
			initial: () => ({ count: 1 }),
		});
		const Current = defineDoc<{ count: number }>({
			kind: "migration.retire",
			version: 2,
			scope: "session",
			initial: () => ({ count: 0 }),
			migrate: (value) => ({ count: value.count as number }),
			checkpointWhen: () => {
				throw new Error("must not run");
			},
		});
		const { session, storage } = openTestSession();
		await session.commit((tx) => tx.doc(Old).then(() => undefined), context);
		await session.unloadDocuments();
		await session.commit(async (tx) => {
			await tx.doc(Current);
			await tx.retireDoc(Current);
		}, context);
		expect(documentWrites(storage.commits.at(-1)!)).toEqual([
			expect.objectContaining({
				type: "document.change",
				content: { kind: "base", version: 2, value: { count: 1 } },
			}),
			expect.objectContaining({ type: "document.retire" }),
		]);
	});

	it("leaves unaccessed older documents and unavailable definitions untouched", async () => {
		const FirstV1 = defineDoc<{ count: number }>({
			kind: "migration.lazy.first",
			version: 1,
			scope: "session",
			initial: () => ({ count: 1 }),
		});
		const SecondV1 = defineDoc<{ count: number }>({
			kind: "migration.lazy.second",
			version: 1,
			scope: "session",
			initial: () => ({ count: 2 }),
		});
		let secondMigrations = 0;
		const FirstV2 = defineDoc<{ count: number }>({
			kind: "migration.lazy.first",
			version: 2,
			scope: "session",
			initial: () => ({ count: 0 }),
			migrate: (value) => ({ count: value.count as number }),
		});
		defineDoc<{ count: number }>({
			kind: "migration.lazy.second",
			version: 2,
			scope: "session",
			initial: () => ({ count: 0 }),
			migrate: (value) => {
				secondMigrations++;
				return { count: value.count as number };
			},
		});
		const { session, storage } = openTestSession();
		await session.commit(async (tx) => {
			await tx.doc(FirstV1);
			await tx.doc(SecondV1);
		}, context);
		await session.unloadDocuments();
		const commits = storage.commits.length;
		expect(await session.snapshot(FirstV2, context)).toEqual({ count: 1 });
		expect(storage.commits).toHaveLength(commits);
		expect(secondMigrations).toBe(0);
		const secondRecord = await storage.findDocument(
			{ kind: "migration.lazy.second", scope: { kind: "session" } },
			"current",
			context,
		);
		expect((await storage.document(secondRecord!.id, "current", context))!.version).toBe(1);
	});
});

describe("Session historical document snapshots", () => {
	it("migrates current and historical rewindable values independently and follows fork ancestry", async () => {
		const V1 = defineDoc<{ count: number }>({
			kind: "history.migration",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ count: 0 }),
		});
		const Family = defineDocFamily<{ seed: string; count: number }, string>({
			kind: "history.family",
			version: 1,
			family: true,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: (seed) => ({ seed, count: 0 }),
		});
		const migrations: number[] = [];
		const V3 = defineDoc<{ count: number; version: number }>({
			kind: "history.migration",
			version: 3,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ count: 0, version: 3 }),
			migrate: (value, fromVersion) => {
				migrations.push(fromVersion);
				return { count: value.count as number, version: 3 };
			},
		});
		const { session, storage } = openTestSession();
		const conversationId = await createConversation(session);
		let firstEntry!: EntryId;
		let secondEntry!: EntryId;
		let thirdEntry!: EntryId;
		await session.commit(async (tx) => {
			firstEntry = (await tx.appendEntry(conversationId, { kind: "first" })).id;
			(await tx.doc(V1, conversationId)).count = 1;
			(await tx.doc(Family, conversationId, "member", "seed")).count = 1;
		}, context);
		await session.commit(async (tx) => {
			secondEntry = (await tx.appendEntry(conversationId, { kind: "second" })).id;
			(await tx.doc(V1, conversationId)).count = 2;
		}, context);
		await session.unloadDocuments();
		const commits = storage.commits.length;
		expect(await session.snapshot(V3, conversationId, context)).toEqual({ count: 2, version: 3 });
		expect(migrations).toEqual([1]);
		expect(storage.commits).toHaveLength(commits);

		await session.commit(async (tx) => {
			thirdEntry = (await tx.appendEntry(conversationId, { kind: "third" })).id;
			await tx.doc(V3, conversationId);
		}, context);
		expect(storage.commits.at(-1)!).toContainEqual(
			expect.objectContaining({
				type: "document.change",
				content: expect.objectContaining({ kind: "base", version: 3 }),
			}),
		);

		expect(await session.snapshotAsOf(V3, conversationId, firstEntry, context)).toEqual({ count: 1, version: 3 });
		expect(await session.snapshotAsOf(V3, conversationId, secondEntry, context)).toEqual({ count: 2, version: 3 });
		expect(await session.snapshotAsOf(V3, conversationId, thirdEntry, context)).toEqual({ count: 2, version: 3 });
		expect(migrations).toEqual([1, 1, 1]);
		expect(await session.snapshotAsOf(Family, conversationId, "member", firstEntry, context)).toEqual({
			seed: "seed",
			count: 1,
		});

		const childId = await session.commit(
			async (tx) =>
				(await tx.forkConversation(conversationId, secondEntry, { ownership: { kind: "ownerless" } })).id,
			context,
		);
		expect(await session.snapshotAsOf(V3, childId, firstEntry, context)).toEqual({ count: 1, version: 3 });
		expect(await session.snapshotAsOf(V3, childId, secondEntry, context)).toEqual({ count: 2, version: 3 });
		expect(await session.snapshotAsOf(Family, childId, "member", firstEntry, context)).toEqual({
			seed: "seed",
			count: 1,
		});
		await expect(session.snapshotAsOf(V3, childId, thirdEntry, context)).rejects.toThrow(
			`Entry ${thirdEntry} is not visible`,
		);
	});

	it("selects the incarnation alive at the entry commit across retirement and recreation", async () => {
		const Doc = defineDoc<{ value: string }>({
			kind: "history.incarnation",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "initial" }),
		});
		const { session } = openTestSession();
		const conversationId = await createConversation(session);
		const beforeCreation = await session.commit(
			async (tx) => (await tx.appendEntry(conversationId, { kind: "before" })).id,
			context,
		);
		let createdAt!: EntryId;
		let retiredAt!: EntryId;
		let recreatedAt!: EntryId;
		await session.commit(async (tx) => {
			createdAt = (await tx.appendEntry(conversationId, { kind: "create" })).id;
			(await tx.doc(Doc, conversationId)).value = "old";
		}, context);
		await session.commit(async (tx) => {
			retiredAt = (await tx.appendEntry(conversationId, { kind: "retire" })).id;
			await tx.retireDoc(Doc, conversationId);
		}, context);
		await session.commit(async (tx) => {
			recreatedAt = (await tx.appendEntry(conversationId, { kind: "recreate" })).id;
			(await tx.doc(Doc, conversationId)).value = "new";
		}, context);

		expect(await session.snapshotAsOf(Doc, conversationId, beforeCreation, context)).toBeUndefined();
		expect(await session.snapshotAsOf(Doc, conversationId, createdAt, context)).toEqual({ value: "old" });
		expect(await session.snapshotAsOf(Doc, conversationId, retiredAt, context)).toBeUndefined();
		expect(await session.snapshotAsOf(Doc, conversationId, recreatedAt, context)).toEqual({ value: "new" });
		await session.close(context);
		await expect(session.snapshotAsOf(Doc, conversationId, recreatedAt, context)).rejects.toThrow("closed");
	});
});
