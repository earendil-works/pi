import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import type { ForkDestinationSnapshot } from "../../src/harness/session/fork.ts";
import { JSONL_FORMAT_VERSION, JsonlStorage, type JsonlStorageHeader } from "../../src/harness/session/jsonl/index.ts";
import * as storedValues from "../../src/harness/session/values.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;

function header(id: string): JsonlStorageHeader {
	return {
		v: JSONL_FORMAT_VERSION,
		kind: "header",
		id,
		storageVersion: 1,
		createdAt: NOW,
		cwd: "/workspace",
	};
}

function stored<T>(address: storedValues.Value<T>, value: T, seq: number): storedValues.StoredValue<unknown> {
	return {
		address: storedValues.value<unknown>(address.namespace, address.key),
		value,
		seq,
	};
}

function preparedSnapshot(): ForkDestinationSnapshot {
	return {
		entries: new Map([
			[
				"root",
				{
					id: "root",
					parentId: null,
					type: "message",
					message: { role: "user", content: "hello", timestamp: 1 },
					seq: 1,
					timestamp: NOW,
				},
			],
		]),
		scalarValues: [
			stored(storedValues.branchTip("main"), "root", 2),
			stored(storedValues.laneState("main"), { currentOperationId: null, lastOperationId: null, inbox: [] }, 3),
			stored(storedValues.sessionName, "forked", 4),
		],
		nextSeq: 9,
	};
}

describe("JsonlStorage snapshot creation", () => {
	it("atomically publishes, advances, and reopens a prepared snapshot", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "fork.jsonl", now: () => NOW };
		const storage = await JsonlStorage.createFromForkSnapshot(
			options,
			header("fork"),
			preparedSnapshot(),
			BACKGROUND_CONTEXT,
		);

		const lines = getOrThrow(await fileSystem.readTextFile("fork.jsonl", BACKGROUND_CONTEXT))
			.trimEnd()
			.split("\n");
		expect(lines.slice(1).every((line) => !Array.isArray(JSON.parse(line)))).toBe(true);
		expect((await storage.getEntries(["root"], BACKGROUND_CONTEXT)).get("root")?.timestamp).toBe(NOW);
		expect((await storage.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT))?.value).toBe("root");
		expect((await storage.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			currentOperationId: null,
			lastOperationId: null,
			inbox: [],
		});
		expect((await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("forked");
		expect(await storage.getStats(BACKGROUND_CONTEXT)).toEqual({
			messageCount: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		expect(await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual([]);
		expect(
			(await storage.commit([storedValues.setValue(storedValues.sessionName, "updated")], BACKGROUND_CONTEXT))
				.firstSeq,
		).toBe(9);
		expect(getOrThrow(await fileSystem.exists("fork.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
		await storage.close(BACKGROUND_CONTEXT);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["root"], BACKGROUND_CONTEXT)).has("root")).toBe(true);
		expect((await reopened.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("updated");
		expect((await reopened.commit([], BACKGROUND_CONTEXT)).firstSeq).toBe(10);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("removes the temporary file when publication fails", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		getOrThrow(await fileSystem.createDir("blocked.jsonl", undefined, BACKGROUND_CONTEXT));

		await expect(
			JsonlStorage.createFromForkSnapshot(
				{ fileSystem, path: "blocked.jsonl", now: () => NOW },
				header("blocked"),
				preparedSnapshot(),
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow("Failed to publish JSONL storage");
		expect(getOrThrow(await fileSystem.exists("blocked.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
		expect(getOrThrow(await fileSystem.fileInfo("blocked.jsonl", BACKGROUND_CONTEXT))).toMatchObject({
			kind: "directory",
		});
	});
});

describe("JsonlStorage persistence", () => {
	it("replays whole-list deletion without resurrecting earlier appends", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "list-delete.jsonl", now: () => NOW };
		const events = storedValues.list<string>("test.events");
		const storage = await JsonlStorage.create(options, header("list-delete"), [], BACKGROUND_CONTEXT);
		await storage.commit(
			[storedValues.appendList(events, "first"), storedValues.appendList(events, "second")],
			BACKGROUND_CONTEXT,
		);
		await storage.commit([storedValues.deleteList(events)], BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect(await reopened.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([]);
		const recreated = await reopened.commit([storedValues.appendList(events, "after")], BACKGROUND_CONTEXT);
		expect(recreated.firstSeq).toBe(4);
		expect(await reopened.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([{ seq: 4, value: "after" }]);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("writes one line per transaction and replays stamped state", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		const storage = await JsonlStorage.create(options, header("round-trip"), [], BACKGROUND_CONTEXT);
		const committed = await storage.commit(
			[
				sessionWrites.insertEntry({
					id: "root",
					parentId: null,
					type: "message",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
				storedValues.setValue(storedValues.branchTip("main"), "root"),
				sessionWrites.insertUsage({
					id: "usage",
					entryId: "root",
					adjustment: false,
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			],
			BACKGROUND_CONTEXT,
		);
		await storage.commit([storedValues.setValue(storedValues.sessionName, "name")], BACKGROUND_CONTEXT);

		const lines = getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))
			.trimEnd()
			.split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(header("round-trip"));
		expect(JSON.parse(lines[1]!)).toHaveLength(3);
		expect(Array.isArray(JSON.parse(lines[2]!))).toBe(false);
		await storage.close(BACKGROUND_CONTEXT);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["root"], BACKGROUND_CONTEXT)).get("root")).toEqual({
			id: "root",
			parentId: null,
			type: "message",
			message: { role: "user", content: "hello", timestamp: 1 },
			seq: committed.seqs[0],
			timestamp: committed.timestamp,
		});
		expect(await reopened.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT)).toEqual({
			address: storedValues.branchTip("main"),
			value: "root",
			seq: committed.seqs[1],
		});
		expect(
			(await reopened.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id, seq }) => ({ id, seq })),
		).toEqual([{ id: "usage", seq: committed.seqs[2] }]);
		const historicalStats = {
			messageCount: 1,
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		expect(await reopened.getStats(BACKGROUND_CONTEXT)).toEqual(historicalStats);
		const next = await reopened.commit([], BACKGROUND_CONTEXT);
		expect(next.firstSeq).toBe(5);
		expect(next.stats).toEqual(historicalStats);
		await reopened.close(BACKGROUND_CONTEXT);
	});
});

describe("JsonlStorage snapshots", () => {
	it("captures one serialized boundary between commits", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		const storage = await JsonlStorage.create(options, header("snapshot"), [], BACKGROUND_CONTEXT);

		const firstCommit = storage.commit(
			[
				sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
				storedValues.setValue(storedValues.branchTip("main"), "root"),
			],
			BACKGROUND_CONTEXT,
		);
		const snapshot = storage.captureForkSource(BACKGROUND_CONTEXT);
		const secondCommit = storage.commit(
			[
				sessionWrites.insertEntry({ id: "child", parentId: "root", type: "custom", customType: "child" }),
				storedValues.setValue(storedValues.branchTip("main"), "child"),
			],
			BACKGROUND_CONTEXT,
		);

		await firstCommit;
		const captured = await snapshot;
		await secondCommit;

		expect(captured.entries.map(({ id }) => id)).toEqual(["root"]);
		expect(
			captured.scalarValues.find(
				({ address }) => address.namespace === storedValues.branchTip("main").namespace && address.key === "main",
			)?.value,
		).toBe("root");
		expect((await storage.getEntries(["child"], BACKGROUND_CONTEXT)).has("child")).toBe(true);
		expect((await storage.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT))?.value).toBe("child");
		await storage.close(BACKGROUND_CONTEXT);
	});
});

describe("JsonlStorage torn tail", () => {
	function entryWrite(id: string) {
		return sessionWrites.insertEntry({
			id,
			parentId: null,
			type: "message",
			message: { role: "user", content: id, timestamp: 1 },
		});
	}

	async function seed() {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl" as const, now: () => NOW };
		const storage = await JsonlStorage.create(options, header("torn"), [], BACKGROUND_CONTEXT);
		await storage.commit([entryWrite("kept")], BACKGROUND_CONTEXT);
		await storage.close(BACKGROUND_CONTEXT);
		const prefix = getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT));
		return { fileSystem, options, prefix };
	}

	it("discards an unterminated final object line and truncates before admitting writes", async () => {
		const { fileSystem, options, prefix } = await seed();
		await fileSystem.appendFile(
			"session.jsonl",
			JSON.stringify({
				kind: "entry",
				id: "torn",
				parentId: null,
				type: "message",
				message: { role: "user", content: "torn", timestamp: 1 },
				seq: 2,
				timestamp: NOW,
			}),
			BACKGROUND_CONTEXT,
		);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["kept", "torn"], BACKGROUND_CONTEXT)).has("torn")).toBe(false);
		expect((await reopened.getEntries(["kept"], BACKGROUND_CONTEXT)).get("kept")?.id).toBe("kept");
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(prefix);
		expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);

		const next = await reopened.commit([entryWrite("after")], BACKGROUND_CONTEXT);
		expect(next.firstSeq).toBe(2);
		expect((await reopened.getEntries(["after"], BACKGROUND_CONTEXT)).get("after")?.seq).toBe(2);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("discards a torn array line wholly, including list elements", async () => {
		const { fileSystem, options, prefix } = await seed();
		const events = storedValues.list<string>("test.events");
		await fileSystem.appendFile(
			"session.jsonl",
			JSON.stringify([
				{
					kind: "entry",
					id: "torn-a",
					parentId: null,
					type: "message",
					message: { role: "user", content: "torn-a", timestamp: 1 },
					seq: 2,
					timestamp: NOW,
				},
				storedValues.setValue(storedValues.sessionName, "lost"),
				storedValues.appendList(events, "lost"),
			]),
			BACKGROUND_CONTEXT,
		);

		const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
		expect((await reopened.getEntries(["torn-a"], BACKGROUND_CONTEXT)).has("torn-a")).toBe(false);
		expect(await reopened.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await reopened.readList(events, undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(prefix);
		await reopened.close(BACKGROUND_CONTEXT);
	});

	it("rejects a malformed interior line without rewriting", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}not-json\n${JSON.stringify(storedValues.setValue(storedValues.sessionName, "after"))}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
		expect(getOrThrow(await fileSystem.exists("session.jsonl.tmp", BACKGROUND_CONTEXT))).toBe(false);
	});

	it("rejects the unsupported pre-WP01 scalar record spelling", async () => {
		const { fileSystem, options, prefix } = await seed();
		const legacyKind = ["reg", "ister"].join("");
		const corrupted = `${prefix}${JSON.stringify({
			kind: legacyKind,
			op: "set",
			seq: 2,
			namespace: "legacy.value",
			key: "state",
			value: true,
		})}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
	});

	it("rejects a complete malformed final line without rewriting", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}not-json\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
	});

	it("rejects a complete final line with invalid transaction framing", async () => {
		const { fileSystem, options, prefix } = await seed();
		const corrupted = `${prefix}${JSON.stringify({ kind: "nope", seq: 2 })}\n`;
		await fileSystem.writeFile("session.jsonl", corrupted, BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/line 3/);
		expect(getOrThrow(await fileSystem.readTextFile("session.jsonl", BACKGROUND_CONTEXT))).toBe(corrupted);
	});

	it("rejects an unterminated header", async () => {
		const fileSystem = new NodeExecutionEnv({ cwd: createTempDir() });
		const options = { fileSystem, path: "session.jsonl", now: () => NOW };
		await fileSystem.writeFile("session.jsonl", JSON.stringify(header("torn")).slice(0, -4), BACKGROUND_CONTEXT);

		await expect(JsonlStorage.open(options, BACKGROUND_CONTEXT)).rejects.toThrow(/missing header/);
	});
});
