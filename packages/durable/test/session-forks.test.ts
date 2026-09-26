import {
	type ConversationId,
	defineDoc,
	defineDocFamily,
	type EntryId,
	StorageRejected,
	type StorageWrite,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
	context,
	createConversation,
	documentChanges,
	documentCopyChanges,
	flush,
	openTestSession,
} from "./session-support.ts";

function documentCreates(writes: readonly StorageWrite[]) {
	return writes.filter((write) => write.type === "document.create");
}

function documentCopies(writes: readonly StorageWrite[]) {
	return writes.filter((write) => write.type === "document.copy");
}

describe("Session conversation document forks", () => {
	it("copies as-of and current singleton and family bases while leaving initial documents absent", async () => {
		const AsOf = defineDoc<{ value: string }>({
			kind: "fork.policies.as-of",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "as-initial" }),
		});
		const Current = defineDoc<{ value: string }>({
			kind: "fork.policies.current",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ value: "current-initial" }),
		});
		const Initial = defineDoc<{ value: string }>({
			kind: "fork.policies.initial",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({ value: "fresh" }),
		});
		const AsOfFamily = defineDocFamily<{ value: string }, string>({
			kind: "fork.policies.as-of-family",
			version: 1,
			family: true,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: (seed) => ({ value: seed }),
		});
		const CurrentFamily = defineDocFamily<{ value: string }, string>({
			kind: "fork.policies.current-family",
			version: 1,
			family: true,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: (seed) => ({ value: seed }),
		});
		const { session, storage, publications } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "fork-point" })).id;
			(await tx.doc(AsOf, parentId)).value = "as-at-fork";
			(await tx.doc(Current, parentId)).value = "current-at-fork";
			(await tx.doc(Initial, parentId)).value = "parent-only";
			(await tx.doc(AsOfFamily, parentId, "a", "unused")).value = "family-as-a";
			(await tx.doc(AsOfFamily, parentId, "b", "unused")).value = "family-as-b";
			(await tx.doc(CurrentFamily, parentId, "a", "unused")).value = "family-current-a";
		}, context);
		await session.commit(async (tx) => {
			(await tx.doc(AsOf, parentId)).value = "as-after-fork";
			(await tx.doc(Current, parentId)).value = "current-when-copied";
			(await tx.doc(AsOfFamily, parentId, "a", "unused")).value = "family-as-after";
			(await tx.doc(CurrentFamily, parentId, "a", "unused")).value = "family-current-when-copied";
		}, context);
		await flush();
		const documentReads = storage.documentReadCount;

		const child = await session.commit(
			(tx) => tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		await flush();
		expect(storage.documentReadCount).toBe(documentReads);

		expect(await session.snapshot(AsOf, child.id, context)).toEqual({ value: "as-at-fork" });
		expect(await session.snapshot(Current, child.id, context)).toEqual({ value: "current-when-copied" });
		expect(await session.snapshot(Initial, child.id, context)).toBeUndefined();
		expect(await session.snapshot(AsOfFamily, child.id, "a", context)).toEqual({ value: "family-as-a" });
		expect(await session.snapshot(AsOfFamily, child.id, "b", context)).toEqual({ value: "family-as-b" });
		expect(await session.snapshot(CurrentFamily, child.id, "a", context)).toEqual({
			value: "family-current-when-copied",
		});

		const admitted = storage.admittedCommits.at(-1)!;
		const copies = documentCopies(admitted);
		expect(copies).toHaveLength(5);
		expect(copies.every((write) => write.record.scope.kind === "conversation")).toBe(true);
		expect(
			copies.every(
				(write) => write.record.scope.kind === "conversation" && write.record.scope.conversationId === child.id,
			),
		).toBe(true);
		const publication = publications.at(-1)!;
		const copied = documentCopyChanges(publication);
		expect(copied).toHaveLength(5);
		for (const change of copied) {
			expect(change.record.createdAt).toBe(publication.seq);
			expect(change.conversationId).toBe(child.id);
			const write = copies.find((candidate) => candidate.record.id === change.record.id)!;
			expect(change.source).toEqual(write.source);
		}

		const parentRecord = await storage.findDocument(
			{ kind: AsOf.definition.kind, scope: { kind: "conversation", conversationId: parentId } },
			"current",
			context,
		);
		const childRecord = await storage.findDocument(
			{ kind: AsOf.definition.kind, scope: { kind: "conversation", conversationId: child.id } },
			"current",
			context,
		);
		expect(childRecord!.id).not.toBe(parentRecord!.id);

		await session.commit(async (tx) => {
			(await tx.doc(AsOf, child.id)).value = "child-independent";
		}, context);
		expect(await session.snapshot(AsOf, parentId, context)).toEqual({ value: "as-after-fork" });
		expect(await session.snapshot(AsOf, child.id, context)).toEqual({ value: "child-independent" });
		await session.commit(async (tx) => {
			(await tx.doc(Initial, child.id)).value = "child-created";
		}, context);
		expect(await session.snapshot(Initial, child.id, context)).toEqual({ value: "child-created" });
	});

	it("uses final document state from the fork entry commit while excluding later same-commit entries", async () => {
		const Doc = defineDoc<{ value: string }>({
			kind: "fork.same-commit",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "initial" }),
		});
		const { session } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		let excluded!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "included" })).id;
			(await tx.doc(Doc, parentId)).value = "final-state-of-commit";
			excluded = (await tx.appendEntry(parentId, { kind: "excluded" })).id;
		}, context);
		const child = await session.commit(
			(tx) => tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await session.snapshot(Doc, child.id, context)).toEqual({ value: "final-state-of-commit" });
		const visible = await session.commit((tx) => tx.scanEntries({ conversationId: child.id }, 10), context);
		expect(visible.items.map(({ id }) => id)).toContain(forkAt);
		expect(visible.items.map(({ id }) => id)).not.toContain(excluded);
	});

	it("selects the entry-owning ancestor for as-of copies and the immediate parent for current copies", async () => {
		const AsOf = defineDoc<{ value: string }>({
			kind: "fork.ancestry.as-of",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "initial" }),
		});
		const Current = defineDoc<{ value: string }>({
			kind: "fork.ancestry.current",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ value: "initial" }),
		});
		const { session } = openTestSession();
		const rootId = await createConversation(session);
		let inherited!: EntryId;
		await session.commit(async (tx) => {
			inherited = (await tx.appendEntry(rootId, { kind: "root" })).id;
			(await tx.doc(AsOf, rootId)).value = "root-at-entry";
			(await tx.doc(Current, rootId)).value = "root-current";
		}, context);
		const parent = await session.commit(
			(tx) => tx.forkConversation(rootId, inherited, { ownership: { kind: "ownerless" } }),
			context,
		);
		let parentEntry!: EntryId;
		await session.commit(async (tx) => {
			parentEntry = (await tx.appendEntry(parent.id, { kind: "parent" })).id;
			(await tx.doc(AsOf, parent.id)).value = "parent-at-own-entry";
			(await tx.doc(Current, parent.id)).value = "parent-current";
		}, context);

		const inheritedFork = await session.commit(
			(tx) => tx.forkConversation(parent.id, inherited, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await session.snapshot(AsOf, inheritedFork.id, context)).toEqual({ value: "root-at-entry" });
		expect(await session.snapshot(Current, inheritedFork.id, context)).toEqual({ value: "parent-current" });

		const ownEntryFork = await session.commit(
			(tx) => tx.forkConversation(parent.id, parentEntry, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await session.snapshot(AsOf, ownEntryFork.id, context)).toEqual({ value: "parent-at-own-entry" });
		expect(await session.snapshot(Current, ownEntryFork.id, context)).toEqual({ value: "parent-current" });
	});

	it("copies the stored value and version without consulting migration definitions or migrated caches", async () => {
		const V1 = defineDoc<{ count: number }>({
			kind: "fork.stored-version",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ count: 1 }),
		});
		let migrations = 0;
		const V3 = defineDoc<{ count: number; migrated: boolean }>({
			kind: "fork.stored-version",
			version: 3,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ count: 0, migrated: false }),
			migrate: (value, fromVersion) => {
				expect(fromVersion).toBe(1);
				migrations++;
				return { count: value.count as number, migrated: true };
			},
		});
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "point" })).id;
			await tx.doc(V1, parentId);
		}, context);
		await session.unloadDocuments();
		expect(await session.snapshot(V3, parentId, context)).toEqual({ count: 1, migrated: true });
		expect(migrations).toBe(1);

		const child = await session.commit(
			(tx) => tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(migrations).toBe(1);
		const childRecord = await storage.findDocument(
			{ kind: V1.definition.kind, scope: { kind: "conversation", conversationId: child.id } },
			"current",
			context,
		);
		const childStored = await storage.document(childRecord!.id, "current", context);
		expect(childStored).toMatchObject({ version: 1, value: { count: 1 } });
		expect(await session.snapshot(V3, child.id, context)).toEqual({ count: 1, migrated: true });
		expect(migrations).toBe(2);
	});

	it("coalesces a typed migration and override into the copied creation base", async () => {
		const V1 = defineDoc<{ count: number }>({
			kind: "fork.override",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ count: 2 }),
		});
		let checkpoints = 0;
		const V2 = defineDoc<{ count: number; migrated: boolean }>({
			kind: "fork.override",
			version: 2,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ count: 0, migrated: false }),
			migrate: (value) => ({ count: value.count as number, migrated: true }),
			checkpointWhen: () => {
				checkpoints++;
				return false;
			},
		});
		const { session, storage, publications } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "point" })).id;
			await tx.doc(V1, parentId);
		}, context);

		const documentReads = storage.documentReadCount;
		const child = await session.commit(async (tx) => {
			const created = await tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } });
			const value = await tx.doc(V2, created.id);
			value.count = 9;
			return created;
		}, context);
		await flush();
		expect(storage.documentReadCount).toBe(documentReads + 1);
		const creates = documentCreates(storage.admittedCommits.at(-1)!);
		expect(creates).toHaveLength(1);
		expect(creates[0]!.content).toMatchObject({
			kind: "base",
			version: 2,
			value: { count: 9, migrated: true },
		});
		expect(checkpoints).toBe(0);
		expect(documentChanges(publications.at(-1)!)).toMatchObject([{ version: 2 }]);
		expect(await session.snapshot(V2, child.id, context)).toEqual({ count: 9, migrated: true });
		const parentRecord = await storage.findDocument(
			{ kind: V1.definition.kind, scope: { kind: "conversation", conversationId: parentId } },
			"current",
			context,
		);
		expect((await storage.document(parentRecord!.id, "current", context))!.version).toBe(1);
	});

	it("copies the incarnation alive at the fork point across retirement and recreation", async () => {
		const Doc = defineDoc<{ value: string }>({
			kind: "fork.incarnations",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "initial" }),
		});
		const { session } = openTestSession();
		const parentId = await createConversation(session);
		let oldAt!: EntryId;
		let retiredAt!: EntryId;
		let newAt!: EntryId;
		await session.commit(async (tx) => {
			oldAt = (await tx.appendEntry(parentId, { kind: "old" })).id;
			(await tx.doc(Doc, parentId)).value = "old";
		}, context);
		await session.commit(async (tx) => {
			retiredAt = (await tx.appendEntry(parentId, { kind: "retired" })).id;
			await tx.retireDoc(Doc, parentId);
		}, context);
		await session.commit(async (tx) => {
			newAt = (await tx.appendEntry(parentId, { kind: "new" })).id;
			(await tx.doc(Doc, parentId)).value = "new";
		}, context);

		const oldChild = await session.commit(
			(tx) => tx.forkConversation(parentId, oldAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		const emptyChild = await session.commit(
			(tx) => tx.forkConversation(parentId, retiredAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		const newChild = await session.commit(
			(tx) => tx.forkConversation(parentId, newAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await session.snapshot(Doc, oldChild.id, context)).toEqual({ value: "old" });
		expect(await session.snapshot(Doc, emptyChild.id, context)).toBeUndefined();
		expect(await session.snapshot(Doc, newChild.id, context)).toEqual({ value: "new" });
	});

	it("rejects invisible fork points before admission and remains usable", async () => {
		const { session, storage, publications } = openTestSession();
		const rootId = await createConversation(session);
		let visible!: EntryId;
		let hidden!: EntryId;
		await session.commit(async (tx) => {
			visible = (await tx.appendEntry(rootId, { kind: "visible" })).id;
			hidden = (await tx.appendEntry(rootId, { kind: "hidden" })).id;
		}, context);
		const parent = await session.commit(
			(tx) => tx.forkConversation(rootId, visible, { ownership: { kind: "ownerless" } }),
			context,
		);
		await flush();
		const commits = storage.commits.length;
		const published = publications.length;
		await expect(
			session.commit((tx) => tx.forkConversation(parent.id, hidden, { ownership: { kind: "ownerless" } }), context),
		).rejects.toThrow(`Entry ${hidden} is not visible`);
		await flush();
		expect(storage.commits).toHaveLength(commits);
		expect(publications).toHaveLength(published);
		const independent = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await storage.conversation(independent.id, context)).toEqual(independent);
	});

	it("rejects duplicate as-of and current selections for one child address before admission", async () => {
		const AsOf = defineDoc<{ value: string }>({
			kind: "fork.duplicate-policy",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "as-of" }),
		});
		const Current = defineDoc<{ value: string }>({
			kind: "fork.duplicate-policy",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ value: "current" }),
		});
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		let oldAt!: EntryId;
		await session.commit(async (tx) => {
			oldAt = (await tx.appendEntry(parentId, { kind: "old" })).id;
			await tx.doc(AsOf, parentId);
		}, context);
		await session.commit((tx) => tx.retireDoc(AsOf, parentId), context);
		await session.commit((tx) => tx.doc(Current, parentId).then(() => undefined), context);
		const commits = storage.commits.length;
		await expect(
			session.commit((tx) => tx.forkConversation(parentId, oldAt, { ownership: { kind: "ownerless" } }), context),
		).rejects.toThrow("Fork selects multiple source documents");
		expect(storage.commits).toHaveLength(commits);
		const independent = await session.commit(
			(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await storage.conversation(independent.id, context)).toEqual(independent);
	});

	it("rejects current and as-of source writes in the fork transaction", async () => {
		const Current = defineDoc<{ value: string }>({
			kind: "fork.same-transaction-current",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ value: "committed" }),
		});
		const AsOf = defineDoc<{ value: string }>({
			kind: "fork.same-transaction-as-of",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "committed" }),
		});
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "point" })).id;
			await tx.doc(Current, parentId);
			await tx.doc(AsOf, parentId);
		}, context);
		const commits = storage.commits.length;
		await expect(
			session.commit(async (tx) => {
				(await tx.doc(Current, parentId)).value = "before-fork";
				await tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } });
			}, context),
		).rejects.toThrow("Cannot change fork source document");
		await expect(
			session.commit(async (tx) => {
				await tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } });
				(await tx.doc(Current, parentId)).value = "after-fork";
			}, context),
		).rejects.toThrow("Cannot change fork source document");
		await expect(
			session.commit(async (tx) => {
				(await tx.doc(AsOf, parentId)).value = "as-of-write";
				await tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } });
			}, context),
		).rejects.toThrow("Cannot change fork source document");
		expect(storage.commits).toHaveLength(commits);
		expect(await session.snapshot(Current, parentId, context)).toEqual({ value: "committed" });
		const child = await session.commit(
			(tx) => tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(await session.snapshot(Current, child.id, context)).toEqual({ value: "committed" });
	});

	it("rolls every copied base back when later pre-admission assembly fails", async () => {
		const Copied = defineDoc<{ value: string }>({
			kind: "fork.rollback.copied",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "copied" }),
		});
		let failCheckpoint = true;
		const Failure = defineDoc<{ count: number }>({
			kind: "fork.rollback.failure",
			version: 1,
			scope: "session",
			initial: () => ({ count: 0 }),
			checkpointWhen: () => {
				if (failCheckpoint) throw new Error("checkpoint failed");
				return false;
			},
		});
		const { session, storage, publications } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "point" })).id;
			await tx.doc(Copied, parentId);
			await tx.doc(Failure);
		}, context);
		await flush();
		const commits = storage.commits.length;
		const published = publications.length;
		let childId!: ConversationId;
		await expect(
			session.commit(async (tx) => {
				childId = (await tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } })).id;
				(await tx.doc(Failure)).count = 1;
			}, context),
		).rejects.toThrow("checkpoint failed");
		await flush();
		expect(storage.commits).toHaveLength(commits);
		expect(publications).toHaveLength(published);
		expect(await storage.conversation(childId, context)).toBeUndefined();
		failCheckpoint = false;
		await session.commit(async (tx) => {
			(await tx.doc(Failure)).count = 2;
		}, context);
		expect(await session.snapshot(Failure, context)).toEqual({ count: 2 });
		expect(await session.snapshot(Copied, parentId, context)).toEqual({ value: "copied" });
	});

	it("rolls back a guaranteed Storage rejection without poisoning the Session", async () => {
		const Doc = defineDoc<{ value: string }>({
			kind: "fork.storage-rejected",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "source" }),
		});
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "point" })).id;
			await tx.doc(Doc, parentId);
		}, context);
		let rejectedChildId!: ConversationId;
		storage.failNextCommit(new StorageRejected("copy rejected"));
		await expect(
			session.commit(async (tx) => {
				rejectedChildId = (await tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } })).id;
			}, context),
		).rejects.toThrow("copy rejected");
		expect(await storage.conversation(rejectedChildId, context)).toBeUndefined();
		const next = await session.commit((tx) => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
		expect(await storage.conversation(next.id, context)).toEqual(next);
	});

	it("retires a copied document and can recreate the address in the fork transaction", async () => {
		const Doc = defineDoc<{ value: string }>({
			kind: "fork.retire-recreate",
			version: 1,
			scope: "conversation",
			history: "rewindable",
			fork: "asOf",
			initial: () => ({ value: "fresh" }),
		});
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "point" })).id;
			(await tx.doc(Doc, parentId)).value = "copied";
		}, context);
		const child = await session.commit(async (tx) => {
			const created = await tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } });
			await tx.retireDoc(Doc, created.id);
			(await tx.doc(Doc, created.id)).value = "replacement";
			return created;
		}, context);
		const writes = storage.commits.at(-1)!;
		expect(writes.filter((write) => write.type === "document.copy")).toHaveLength(1);
		expect(writes.filter((write) => write.type === "document.create")).toHaveLength(1);
		expect(writes.filter((write) => write.type === "document.retire")).toHaveLength(1);
		expect(await session.snapshot(Doc, child.id, context)).toEqual({ value: "replacement" });
	});

	it("copies only conversation documents, leaving Session and task documents in their original scopes", async () => {
		const Copied = defineDoc<{ value: string }>({
			kind: "fork.scope.conversation",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ value: "conversation" }),
		});
		const SessionOnly = defineDoc<{ value: string }>({
			kind: "fork.scope.session",
			version: 1,
			scope: "session",
			initial: () => ({ value: "session" }),
		});
		const TaskOnly = defineDoc<{ value: string }>({
			kind: "fork.scope.task",
			version: 1,
			scope: "task",
			initial: () => ({ value: "task" }),
		});
		const Work = {
			definition: {
				name: "fork.scope.work",
				version: 1,
				initial: () => ({ phase: "start" }),
			},
		};
		const { session, storage, publications } = openTestSession();
		const parentId = await createConversation(session);
		let forkAt!: EntryId;
		let taskId!: TaskId;
		await session.commit(async (tx) => {
			forkAt = (await tx.appendEntry(parentId, { kind: "point" })).id;
			taskId = await tx.createTask(Work, null, { conversationId: parentId });
			await tx.doc(Copied, parentId);
			await tx.doc(SessionOnly);
			await tx.doc(TaskOnly, taskId);
		}, context);
		const child = await session.commit(
			(tx) => tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		await flush();
		const copies = documentCopies(storage.commits.at(-1)!);
		expect(copies.map((write) => write.record.kind)).toEqual([Copied.definition.kind]);
		expect(documentCopyChanges(publications.at(-1)!).map((change) => change.record.kind)).toEqual([
			Copied.definition.kind,
		]);
		expect(await session.snapshot(Copied, child.id, context)).toEqual({ value: "conversation" });
		expect(await session.snapshot(SessionOnly, context)).toEqual({ value: "session" });
		expect(await session.snapshot(TaskOnly, taskId, context)).toEqual({ value: "task" });
	});

	it("copies every family member across storage scan pages", async () => {
		const Family = defineDocFamily<{ value: number }, number>({
			kind: "fork.pagination",
			version: 1,
			family: true,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: (seed) => ({ value: seed }),
		});
		const { session, storage } = openTestSession();
		const parentId = await createConversation(session);
		const forkAt = await session.commit(
			async (tx) => (await tx.appendEntry(parentId, { kind: "point" })).id,
			context,
		);
		await session.commit(async (tx) => {
			await Promise.all(
				Array.from({ length: 260 }, async (_, index) => {
					await tx.doc(Family, parentId, `member-${index}`, index);
				}),
			);
		}, context);
		const child = await session.commit(
			(tx) => tx.forkConversation(parentId, forkAt, { ownership: { kind: "ownerless" } }),
			context,
		);
		expect(documentCopies(storage.commits.at(-1)!)).toHaveLength(260);
		expect(await session.snapshot(Family, child.id, "member-0", context)).toEqual({ value: 0 });
		expect(await session.snapshot(Family, child.id, "member-259", context)).toEqual({ value: 259 });
	});
});
