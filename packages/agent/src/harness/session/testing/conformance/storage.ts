import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "../../../context.ts";
import { insertEntry, insertUsage } from "../../commit.ts";
import type {
	CommitResult,
	CompactionEntry,
	CustomEntry,
	Entry,
	EntryStructure,
	JsonValue,
	MessageEntry,
	NewEntry,
	Storage,
	Write,
} from "../../types.ts";
import {
	appendList,
	branchTip,
	deleteList,
	deleteValue,
	entryLabel,
	list,
	pendingEntry,
	setValue,
	value,
} from "../../values.ts";
import type { ConformanceCase, StorageFixture } from "../types.ts";

const MESSAGE_TIMESTAMP = 1_650_000_000_000;
const testName = value<string>("test.session.name");
const testValue = (key: string) => value<JsonValue>("test.value", key);
const testValuePrefix = (prefix = "") => value<JsonValue>("test.value", prefix);
const testList = (key: string) => list<JsonValue>("test.list", key);

type ConformanceTest = (fixture: StorageFixture) => Promise<void>;

function createCase(
	factory: () => Promise<StorageFixture>,
	group: string,
	name: string,
	test: ConformanceTest,
): ConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture);
		},
	};
}

function usage(input: number, output: number, options: { cacheWrite1h?: number; reasoning?: number } = {}): Usage {
	return {
		input,
		output,
		cacheRead: input + 1,
		cacheWrite: output + 1,
		...(options.cacheWrite1h === undefined ? {} : { cacheWrite1h: options.cacheWrite1h }),
		...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
		totalTokens: input + output,
		cost: {
			input: input / 100,
			output: output / 100,
			cacheRead: (input + 1) / 100,
			cacheWrite: (output + 1) / 100,
			total: (input + output + 2) / 100,
		},
	};
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userEntry(id: string, parentId: string | null = null, text = id): NewEntry<MessageEntry> {
	return {
		id,
		parentId,
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: MESSAGE_TIMESTAMP,
		},
	};
}

function customEntry(
	id: string,
	parentId: string | null,
	customType = "note",
	data: CustomEntry["data"] = { id },
): NewEntry<CustomEntry> {
	return { id, parentId, type: "custom", customType, data };
}

function compactionEntry(id: string, parentId: string | null): NewEntry<CompactionEntry> {
	return {
		id,
		parentId,
		type: "compaction",
		summary: `summary:${id}`,
		retainedTail: [],
		tokensBefore: 10,
		fromHook: false,
	};
}

// EntryStructure is included for scanBranchStructure conformance, especially SQLite's payload-free branch scans.
function ids(entries: readonly (Entry | EntryStructure)[]): string[] {
	return entries.map((entry) => entry.id);
}

function assertStrictlyIncreasing(values: readonly number[]): void {
	for (let index = 1; index < values.length; index++) {
		ok(values[index - 1] < values[index], `Expected ${values.join(", ")} to be strictly increasing`);
	}
}

async function assertCommitStats(storage: Storage, result: CommitResult): Promise<void> {
	deepStrictEqual(result.stats, await storage.getStats(BACKGROUND_CONTEXT));
}

/** Creates fresh, runner-independent cases for the durable Storage contract. */
export function createStorageConformance(factory: () => Promise<StorageFixture>): readonly ConformanceCase[] {
	return [
		createCase(factory, "transactions", "commits mixed writes atomically in write order", async ({ storage }) => {
			const result = await storage.commit(
				[
					insertEntry(userEntry("entry")),
					setValue(testName, "session"),
					insertUsage({ id: "usage", usage: usage(2, 3), adjustment: false, entryId: "entry" }),
				],
				BACKGROUND_CONTEXT,
			);

			strictEqual(result.seqs.length, 3);
			strictEqual(result.firstSeq, result.seqs[0]);
			await assertCommitStats(storage, result);
			assertStrictlyIncreasing(result.seqs);
			ok(Number.isSafeInteger(result.timestamp) && result.timestamp >= 0);
			deepStrictEqual(
				await storage.getEntries(["entry"], BACKGROUND_CONTEXT),
				new Map([["entry", { ...userEntry("entry"), seq: result.seqs[0], timestamp: result.timestamp }]]),
			);
			deepStrictEqual(await storage.getValue(testName, BACKGROUND_CONTEXT), {
				address: testName,
				value: "session",
				seq: result.seqs[1],
			});
			deepStrictEqual(await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT), [
				{ id: "usage", seq: result.seqs[2], usage: usage(2, 3), adjustment: false, entryId: "entry" },
			]);
		}),

		createCase(
			factory,
			"transactions",
			"rolls back every store when a mixed transaction fails",
			async ({ storage }) => {
				await storage.commit(
					[insertEntry(userEntry("root")), insertUsage({ id: "taken", usage: usage(1, 1), adjustment: false })],
					BACKGROUND_CONTEXT,
				);
				const entriesBefore = await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
				const usageBefore = await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT);
				const statsBefore = await storage.getStats(BACKGROUND_CONTEXT);

				await rejects(
					storage.commit(
						[
							setValue(testName, "transient"),
							insertEntry(customEntry("transient-entry", "root")),
							insertUsage({ id: "transient-usage", usage: usage(5, 8), adjustment: true }),
							insertEntry(customEntry("taken", "root")),
						],
						BACKGROUND_CONTEXT,
					),
				);

				deepStrictEqual(await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT), entriesBefore);
				deepStrictEqual(await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT), usageBefore);
				deepStrictEqual(await storage.getStats(BACKGROUND_CONTEXT), statsBefore);
				strictEqual(await storage.getValue(testName, BACKGROUND_CONTEXT), undefined);
			},
		),

		createCase(
			factory,
			"transactions",
			"preserves overwritten and deleted values when a transaction fails",
			async ({ storage }) => {
				await storage.commit(
					[
						setValue(testValue("overwritten"), "original"),
						setValue(testValue("deleted"), { kept: true }),
						insertEntry(userEntry("taken")),
					],
					BACKGROUND_CONTEXT,
				);
				const overwrittenBefore = await storage.getValue(testValue("overwritten"), BACKGROUND_CONTEXT);
				const deletedBefore = await storage.getValue(testValue("deleted"), BACKGROUND_CONTEXT);

				await rejects(
					storage.commit(
						[
							setValue(testValue("overwritten"), "transient"),
							deleteValue(testValue("deleted")),
							insertEntry(customEntry("transient", "taken")),
							insertEntry(customEntry("taken", null)),
						],
						BACKGROUND_CONTEXT,
					),
				);

				deepStrictEqual(await storage.getValue(testValue("overwritten"), BACKGROUND_CONTEXT), overwrittenBefore);
				deepStrictEqual(await storage.getValue(testValue("deleted"), BACKGROUND_CONTEXT), deletedBefore);
				strictEqual((await storage.getEntries(["transient"], BACKGROUND_CONTEXT)).has("transient"), false);
			},
		),

		createCase(factory, "transactions", "enforces one shared entry and usage id namespace", async ({ storage }) => {
			await storage.commit(
				[
					insertEntry(userEntry("existing-entry")),
					insertUsage({ id: "existing-usage", usage: usage(1, 1), adjustment: false }),
				],
				BACKGROUND_CONTEXT,
			);

			await rejects(
				storage.commit(
					[insertUsage({ id: "existing-entry", usage: usage(2, 2), adjustment: false })],
					BACKGROUND_CONTEXT,
				),
			);
			await rejects(storage.commit([insertEntry(customEntry("existing-usage", null))], BACKGROUND_CONTEXT));

			for (const [id, writes] of [
				[
					"entry-then-usage",
					[
						insertEntry(customEntry("entry-then-usage", null)),
						insertUsage({ id: "entry-then-usage", usage: usage(3, 3), adjustment: false }),
					],
				],
				[
					"usage-then-entry",
					[
						insertUsage({ id: "usage-then-entry", usage: usage(4, 4), adjustment: false }),
						insertEntry(customEntry("usage-then-entry", null)),
					],
				],
			] satisfies Array<[string, Write[]]>) {
				await rejects(storage.commit(writes, BACKGROUND_CONTEXT), `Expected duplicate id ${id} to reject`);
			}

			deepStrictEqual(ids(await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT)), ["existing-entry"]);
			deepStrictEqual(
				(await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).map((row) => row.id),
				["existing-usage"],
			);
		}),

		createCase(
			factory,
			"transactions",
			"resolves parents only from prior entries and earlier writes",
			async ({ storage }) => {
				await storage.commit([insertEntry(userEntry("root"))], BACKGROUND_CONTEXT);
				await storage.commit(
					[insertEntry(customEntry("child", "root")), insertEntry(customEntry("grandchild", "child"))],
					BACKGROUND_CONTEXT,
				);
				deepStrictEqual(
					ids(await storage.scanBranch({ start: "grandchild", order: "oldestFirst" }, BACKGROUND_CONTEXT)),
					["root", "child", "grandchild"],
				);

				await rejects(
					storage.commit(
						[
							insertEntry(customEntry("before-parent", "later-parent")),
							insertEntry(customEntry("later-parent", "root")),
							setValue(entryLabel("before-parent"), "transient"),
						],
						BACKGROUND_CONTEXT,
					),
				);
				await rejects(storage.commit([insertEntry(customEntry("orphan", "missing"))], BACKGROUND_CONTEXT));
				await storage.commit(
					[insertUsage({ id: "usage-is-not-parent", usage: usage(1, 1), adjustment: false })],
					BACKGROUND_CONTEXT,
				);
				await rejects(
					storage.commit([insertEntry(customEntry("usage-child", "usage-is-not-parent"))], BACKGROUND_CONTEXT),
				);

				deepStrictEqual(
					await storage.getEntries(["before-parent", "later-parent", "orphan", "usage-child"], BACKGROUND_CONTEXT),
					new Map(),
				);
				strictEqual(await storage.getValue(entryLabel("before-parent"), BACKGROUND_CONTEXT), undefined);
			},
		),

		createCase(factory, "transactions", "places pending content under its reserved entry id", async ({ storage }) => {
			const entry = userEntry("reserved", null, "queued");
			await storage.commit(
				[
					setValue(pendingEntry(entry.id), { type: "message", payload: entry.message }),
					setValue(branchTip("main"), null),
				],
				BACKGROUND_CONTEXT,
			);

			strictEqual((await storage.getEntries([entry.id], BACKGROUND_CONTEXT)).has(entry.id), false);
			deepStrictEqual((await storage.getValue(pendingEntry(entry.id), BACKGROUND_CONTEXT))?.value, {
				type: "message",
				payload: entry.message,
			});
			strictEqual((await storage.getValue(branchTip("main"), BACKGROUND_CONTEXT))?.value, null);

			const placement = await storage.commit(
				[insertEntry(entry), deleteValue(pendingEntry(entry.id)), setValue(branchTip("main"), entry.id)],
				BACKGROUND_CONTEXT,
			);

			deepStrictEqual(
				await storage.getEntries([entry.id], BACKGROUND_CONTEXT),
				new Map([[entry.id, { ...entry, seq: placement.seqs[0], timestamp: placement.timestamp }]]),
			);
			strictEqual(await storage.getValue(pendingEntry(entry.id), BACKGROUND_CONTEXT), undefined);
			deepStrictEqual(await storage.getValue(branchTip("main"), BACKGROUND_CONTEXT), {
				address: branchTip("main"),
				value: entry.id,
				seq: placement.seqs[2],
			});
		}),

		createCase(
			factory,
			"values",
			"sets, replaces, deletes, and recreates values without tombstones",
			async ({ storage }) => {
				const first = await storage.commit(
					[
						setValue(testValue("prefix/b"), 1),
						setValue(testValue("prefix/a"), 2),
						setValue(testValue("other"), 3),
						setValue(testValue("prefix/\ue000"), 4),
						setValue(testValue("prefix/\u{10000}"), 5),
						setValue(testValue("prefix/a"), null),
					],
					BACKGROUND_CONTEXT,
				);
				deepStrictEqual(await storage.getValue(testValue("prefix/a"), BACKGROUND_CONTEXT), {
					address: testValue("prefix/a"),
					value: null,
					seq: first.seqs[5],
				});

				const second = await storage.commit(
					[
						deleteValue(testValue("prefix/a")),
						deleteValue(testValue("absent")),
						setValue(testValue("prefix/a"), "recreated"),
					],
					BACKGROUND_CONTEXT,
				);

				deepStrictEqual(await storage.scanValues(testValuePrefix("prefix/"), BACKGROUND_CONTEXT), [
					{ address: testValue("prefix/a"), value: "recreated", seq: second.seqs[2] },
					{ address: testValue("prefix/b"), value: 1, seq: first.seqs[0] },
					{ address: testValue("prefix/\ue000"), value: 4, seq: first.seqs[3] },
					{ address: testValue("prefix/\u{10000}"), value: 5, seq: first.seqs[4] },
				]);
				strictEqual(await storage.getValue(testValue("absent"), BACKGROUND_CONTEXT), undefined);
			},
		),

		createCase(
			factory,
			"values",
			"applies same-transaction value and list operations in write order",
			async ({ storage }) => {
				const keptValue = testValue("write-order/kept");
				const deletedValue = testValue("write-order/deleted");
				const keptList = testList("write-order/kept");
				const deletedList = testList("write-order/deleted");
				const result = await storage.commit(
					[
						setValue(deletedValue, "transient"),
						deleteValue(deletedValue),
						setValue(keptValue, "transient"),
						setValue(keptValue, "kept"),
						appendList(keptList, "transient"),
						deleteList(keptList),
						appendList(keptList, "kept"),
						appendList(deletedList, "transient"),
						deleteList(deletedList),
					],
					BACKGROUND_CONTEXT,
				);

				strictEqual(await storage.getValue(deletedValue, BACKGROUND_CONTEXT), undefined);
				deepStrictEqual(await storage.getValue(keptValue, BACKGROUND_CONTEXT), {
					address: keptValue,
					value: "kept",
					seq: result.seqs[3],
				});
				deepStrictEqual(await storage.readList(keptList, undefined, BACKGROUND_CONTEXT), [
					{ seq: result.seqs[6], value: "kept" },
				]);
				deepStrictEqual(await storage.readList(deletedList, undefined, BACKGROUND_CONTEXT), []);
			},
		),

		createCase(
			factory,
			"values",
			"does not change historical stores during value-only commits",
			async ({ storage }) => {
				await storage.commit(
					[
						insertEntry(userEntry("root")),
						insertUsage({ id: "historical-usage", usage: usage(2, 3), adjustment: false }),
					],
					BACKGROUND_CONTEXT,
				);
				const entriesBefore = await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
				const usageBefore = await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT);
				const statsBefore = await storage.getStats(BACKGROUND_CONTEXT);

				const result = await storage.commit(
					[setValue(testName, "first"), setValue(testName, "second")],
					BACKGROUND_CONTEXT,
				);

				deepStrictEqual(await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT), entriesBefore);
				deepStrictEqual(await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT), usageBefore);
				deepStrictEqual(await storage.getStats(BACKGROUND_CONTEXT), statsBefore);
				deepStrictEqual(await storage.getValue(testName, BACKGROUND_CONTEXT), {
					address: testName,
					value: "second",
					seq: result.seqs[1],
				});
			},
		),

		createCase(factory, "lists", "pages appends by global sequence and deletes whole lists", async ({ storage }) => {
			const address = testList("events");
			strictEqual((await storage.readList(address, undefined, BACKGROUND_CONTEXT)).length, 0);
			const result = await storage.commit(
				[appendList(address, "a"), setValue(testName, "gap"), appendList(address, "b"), appendList(address, "c")],
				BACKGROUND_CONTEXT,
			);
			deepStrictEqual(await storage.readList(address, undefined, BACKGROUND_CONTEXT), [
				{ seq: result.seqs[0], value: "a" },
				{ seq: result.seqs[2], value: "b" },
				{ seq: result.seqs[3], value: "c" },
			]);
			deepStrictEqual(await storage.readList(address, { limit: 2 }, BACKGROUND_CONTEXT), [
				{ seq: result.seqs[0], value: "a" },
				{ seq: result.seqs[2], value: "b" },
			]);
			deepStrictEqual(
				await storage.readList(address, { cursor: { seq: result.seqs[0]! }, limit: 2 }, BACKGROUND_CONTEXT),
				[
					{ seq: result.seqs[2], value: "b" },
					{ seq: result.seqs[3], value: "c" },
				],
			);
			deepStrictEqual(await storage.readList(address, { order: "desc", limit: 2 }, BACKGROUND_CONTEXT), [
				{ seq: result.seqs[3], value: "c" },
				{ seq: result.seqs[2], value: "b" },
			]);
			deepStrictEqual(
				await storage.readList(
					address,
					{ order: "desc", cursor: { seq: result.seqs[3]! }, limit: 2 },
					BACKGROUND_CONTEXT,
				),
				[
					{ seq: result.seqs[2], value: "b" },
					{ seq: result.seqs[0], value: "a" },
				],
			);
			await rejects(storage.readList(address, { limit: 0 }, BACKGROUND_CONTEXT));
			await rejects(storage.readList(address, { limit: Number.MAX_VALUE }, BACKGROUND_CONTEXT));

			await storage.commit(
				[deleteList(address), deleteList(testList("absent")), appendList(address, "new")],
				BACKGROUND_CONTEXT,
			);
			deepStrictEqual(
				(await storage.readList(address, undefined, BACKGROUND_CONTEXT)).map(({ value }) => value),
				["new"],
			);
		}),

		createCase(factory, "lists", "clamps one read page without limiting list growth", async ({ storage }) => {
			const address = testList("large");
			await storage.commit(
				Array.from({ length: 10_001 }, (_, index) => appendList(address, index)),
				BACKGROUND_CONTEXT,
			);
			const firstPage = await storage.readList(address, undefined, BACKGROUND_CONTEXT);
			strictEqual(firstPage.length, 1_000);
			strictEqual((await storage.readList(address, { limit: 20_000 }, BACKGROUND_CONTEXT)).length, 10_000);
			strictEqual(
				(
					await storage.readList(
						address,
						{
							cursor: { seq: firstPage.at(-1)!.seq },
						},
						BACKGROUND_CONTEXT,
					)
				).length,
				1_000,
			);
		}),

		createCase(
			factory,
			"lists",
			"commits mixed list writes atomically and rolls them back with siblings",
			async ({ storage }) => {
				const address = testList("atomic");
				const committed = await storage.commit(
					[
						insertEntry(userEntry("mixed")),
						appendList(address, "kept"),
						setValue(testName, "kept"),
						insertUsage({ id: "mixed-usage", usage: usage(1, 2), adjustment: false }),
					],
					BACKGROUND_CONTEXT,
				);
				deepStrictEqual(await storage.readList(address, undefined, BACKGROUND_CONTEXT), [
					{ seq: committed.seqs[1], value: "kept" },
				]);

				await rejects(
					storage.commit(
						[appendList(address, "transient"), deleteValue(testName), insertEntry(userEntry("mixed"))],
						BACKGROUND_CONTEXT,
					),
				);
				deepStrictEqual(await storage.readList(address, undefined, BACKGROUND_CONTEXT), [
					{ seq: committed.seqs[1], value: "kept" },
				]);
				strictEqual((await storage.getValue(testName, BACKGROUND_CONTEXT))?.value, "kept");
			},
		),

		createCase(factory, "entry queries", "stores custom entries with and without data", async ({ storage }) => {
			const result = await storage.commit(
				[
					insertEntry({ id: "without-data", parentId: null, type: "custom", customType: "marker" }),
					insertEntry(customEntry("with-data", "without-data", "note", { nested: [1, 2] })),
				],
				BACKGROUND_CONTEXT,
			);

			deepStrictEqual(
				await storage.getEntries(["without-data", "with-data"], BACKGROUND_CONTEXT),
				new Map([
					[
						"without-data",
						{
							id: "without-data",
							parentId: null,
							type: "custom",
							customType: "marker",
							seq: result.seqs[0],
							timestamp: result.timestamp,
						},
					],
					[
						"with-data",
						{
							...customEntry("with-data", "without-data", "note", { nested: [1, 2] }),
							seq: result.seqs[1],
							timestamp: result.timestamp,
						},
					],
				]),
			);
		}),

		createCase(
			factory,
			"entry queries",
			"scans global entries with explicit ranges, filters, orders, and limits",
			async ({ storage }) => {
				const result = await storage.commit(
					[
						insertEntry(userEntry("root")),
						insertEntry(customEntry("note-1", "root", "note")),
						insertEntry(customEntry("other", "note-1", "other")),
						insertEntry(customEntry("note-2", "other", "note")),
						insertEntry(userEntry("tail", "note-2")),
					],
					BACKGROUND_CONTEXT,
				);

				deepStrictEqual(
					ids(
						await storage.scanEntries(
							{
								type: "custom",
								customType: "note",
								fromSeq: result.seqs[1],
								toSeq: result.seqs[3],
								order: "desc",
							},
							BACKGROUND_CONTEXT,
						),
					),
					["note-2", "note-1"],
				);
				deepStrictEqual(ids(await storage.scanEntries({ order: "asc", limit: 2 }, BACKGROUND_CONTEXT)), [
					"root",
					"note-1",
				]);
				deepStrictEqual(ids(await storage.scanEntries({ order: "desc", limit: 2 }, BACKGROUND_CONTEXT)), [
					"tail",
					"note-2",
				]);
			},
		),

		createCase(
			factory,
			"branch queries",
			"applies stops before filters and cursors before limits",
			async ({ storage }) => {
				const result = await storage.commit(
					[
						insertEntry(userEntry("root")),
						insertEntry(customEntry("marker", "root", "marker")),
						insertEntry(userEntry("middle", "marker")),
						insertEntry(compactionEntry("compact", "middle")),
						insertEntry(customEntry("note", "compact", "note")),
						insertEntry(userEntry("leaf", "note")),
					],
					BACKGROUND_CONTEXT,
				);

				deepStrictEqual(
					ids(
						await storage.scanBranch(
							{ start: "leaf", stopAtType: "compaction", type: "message" },
							BACKGROUND_CONTEXT,
						),
					),
					["leaf"],
				);
				deepStrictEqual(
					ids(
						await storage.scanBranch(
							{
								start: "leaf",
								order: "oldestFirst",
								stopAtId: "middle",
								type: "custom",
							},
							BACKGROUND_CONTEXT,
						),
					),
					["marker"],
				);
				deepStrictEqual(
					ids(
						await storage.scanBranch(
							{
								start: "leaf",
								order: "newestFirst",
								cursor: { seq: result.seqs[4] },
								limit: 2,
							},
							BACKGROUND_CONTEXT,
						),
					),
					["compact", "middle"],
				);
				deepStrictEqual(
					ids(
						await storage.scanBranch(
							{
								start: "leaf",
								order: "oldestFirst",
								cursor: { seq: result.seqs[1] },
								limit: 2,
							},
							BACKGROUND_CONTEXT,
						),
					),
					["middle", "compact"],
				);
				deepStrictEqual(
					ids(await storage.scanBranch({ start: "leaf", stopAtId: "leaf", type: "custom" }, BACKGROUND_CONTEXT)),
					[],
				);
				deepStrictEqual(ids(await storage.scanBranch({ start: "leaf", customType: "note" }, BACKGROUND_CONTEXT)), [
					"note",
				]);
				await rejects(storage.scanBranch({ start: "missing" }, BACKGROUND_CONTEXT));
			},
		),

		createCase(factory, "branch queries", "returns branch structure without payload fields", async ({ storage }) => {
			const result = await storage.commit(
				[insertEntry(userEntry("root")), insertEntry(customEntry("child", "root", "note"))],
				BACKGROUND_CONTEXT,
			);

			deepStrictEqual(
				await storage.scanBranchStructure({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT),
				[
					{
						id: "root",
						parentId: null,
						seq: result.seqs[0],
						timestamp: result.timestamp,
						type: "message",
					},
					{
						id: "child",
						parentId: "root",
						seq: result.seqs[1],
						timestamp: result.timestamp,
						type: "custom",
						customType: "note",
					},
				],
			);
		}),

		createCase(
			factory,
			"branch queries",
			"applies branch query semantics to structure scans",
			async ({ storage }) => {
				const result = await storage.commit(
					[
						insertEntry(userEntry("root")),
						insertEntry(customEntry("marker", "root", "marker")),
						insertEntry(userEntry("middle", "marker")),
						insertEntry(compactionEntry("compact", "middle")),
						insertEntry(customEntry("note", "compact", "note")),
						insertEntry(userEntry("leaf", "note")),
					],
					BACKGROUND_CONTEXT,
				);

				deepStrictEqual(
					ids(
						await storage.scanBranchStructure(
							{ start: "leaf", stopAtType: "compaction", type: "message" },
							BACKGROUND_CONTEXT,
						),
					),
					["leaf"],
				);
				deepStrictEqual(
					ids(
						await storage.scanBranchStructure(
							{ start: "leaf", order: "oldestFirst", cursor: { seq: result.seqs[1] }, limit: 2 },
							BACKGROUND_CONTEXT,
						),
					),
					["middle", "compact"],
				);
				await rejects(storage.scanBranchStructure({ start: "missing" }, BACKGROUND_CONTEXT));
			},
		),

		createCase(
			factory,
			"usage and stats",
			"scans the usage ledger with explicit ranges, orders, and limits",
			async ({ storage }) => {
				const result = await storage.commit(
					[
						insertUsage({ id: "usage-1", usage: usage(1, 1), adjustment: false }),
						setValue(testName, "sequence gap"),
						insertUsage({ id: "usage-2", usage: usage(2, 2), adjustment: false }),
						insertUsage({ id: "usage-3", usage: usage(3, 3), adjustment: true }),
					],
					BACKGROUND_CONTEXT,
				);

				deepStrictEqual(
					(
						await storage.scanUsage(
							{ fromSeq: result.seqs[1], toSeq: result.seqs[2], order: "asc" },
							BACKGROUND_CONTEXT,
						)
					).map((row) => row.id),
					["usage-2"],
				);
				deepStrictEqual(
					(await storage.scanUsage({ order: "desc", limit: 2 }, BACKGROUND_CONTEXT)).map((row) => row.id),
					["usage-3", "usage-2"],
				);
				deepStrictEqual(
					(await storage.scanUsage({ order: "asc", limit: 2 }, BACKGROUND_CONTEXT)).map((row) => row.id),
					["usage-1", "usage-2"],
				);
			},
		),

		createCase(
			factory,
			"usage and stats",
			"keeps stats equal to message count and ledger totals",
			async ({ storage }) => {
				deepStrictEqual(await storage.getStats(BACKGROUND_CONTEXT), { messageCount: 0, usage: zeroUsage() });

				const firstUsage = usage(2, 3, { cacheWrite1h: 4, reasoning: 1 });
				const first = await storage.commit(
					[
						insertEntry(userEntry("message")),
						insertUsage({ id: "usage-1", usage: firstUsage, adjustment: false }),
					],
					BACKGROUND_CONTEXT,
				);
				await assertCommitStats(storage, first);
				deepStrictEqual(first.stats, { messageCount: 1, usage: firstUsage });

				const secondUsage = usage(5, 7, { cacheWrite1h: 6, reasoning: 2 });
				const second = await storage.commit(
					[
						insertEntry(customEntry("custom", "message")),
						insertEntry(compactionEntry("compaction", "custom")),
						insertUsage({ id: "usage-2", usage: secondUsage, adjustment: true }),
					],
					BACKGROUND_CONTEXT,
				);
				await assertCommitStats(storage, second);
				deepStrictEqual(second.stats, {
					messageCount: 1,
					usage: {
						input: 7,
						output: 10,
						cacheRead: 9,
						cacheWrite: 12,
						cacheWrite1h: 10,
						reasoning: 3,
						totalTokens: 17,
						cost: {
							input: firstUsage.cost.input + secondUsage.cost.input,
							output: firstUsage.cost.output + secondUsage.cost.output,
							cacheRead: firstUsage.cost.cacheRead + secondUsage.cost.cacheRead,
							cacheWrite: firstUsage.cost.cacheWrite + secondUsage.cost.cacheWrite,
							total: firstUsage.cost.total + secondUsage.cost.total,
						},
					},
				});
			},
		),

		createCase(
			factory,
			"serialization",
			"serializes back-to-back commits in admission order",
			async ({ storage }) => {
				const first = storage.commit([insertEntry(userEntry("first"))], BACKGROUND_CONTEXT);
				const second = storage.commit([insertEntry(userEntry("second", "first"))], BACKGROUND_CONTEXT);
				const [firstResult, secondResult] = await Promise.all([first, second]);

				ok(firstResult.seqs[0]! < secondResult.seqs[0]!);
				deepStrictEqual(firstResult.stats, { messageCount: 1, usage: zeroUsage() });
				deepStrictEqual(secondResult.stats, { messageCount: 2, usage: zeroUsage() });
				await assertCommitStats(storage, secondResult);
				deepStrictEqual(ids(await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT)), ["first", "second"]);
			},
		),

		createCase(
			factory,
			"lifecycle",
			"seals admission, drains admitted commits, and closes idempotently",
			async ({ storage }) => {
				const admitted = storage.commit([insertEntry(userEntry("admitted"))], BACKGROUND_CONTEXT);
				const firstClose = storage.close(BACKGROUND_CONTEXT);
				const secondClose = storage.close(BACKGROUND_CONTEXT);

				await rejects(storage.getStats(BACKGROUND_CONTEXT));
				await rejects(storage.commit([], BACKGROUND_CONTEXT));
				strictEqual((await admitted).seqs.length, 1);
				await Promise.all([firstClose, secondClose]);

				const rejectedReads = [
					storage.getEntries([], BACKGROUND_CONTEXT),
					storage.getValue(testName, BACKGROUND_CONTEXT),
					storage.scanValues(testName, BACKGROUND_CONTEXT),
					storage.readList(testList("events"), undefined, BACKGROUND_CONTEXT),
					storage.scanBranch({ start: "admitted" }, BACKGROUND_CONTEXT),
					storage.scanBranchStructure({ start: "admitted" }, BACKGROUND_CONTEXT),
					storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT),
					storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT),
					storage.getStats(BACKGROUND_CONTEXT),
				];
				for (const read of rejectedReads) await rejects(read);
			},
		),
	];
}
