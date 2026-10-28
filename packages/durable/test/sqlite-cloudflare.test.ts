import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { durableObjectStorage } from "../../chord/test/sqlite/helpers.ts";
import { idFromNumber } from "../src/ids.ts";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "../src/storage/sqlite/cloudflare.ts";
import { type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

registerStorageConformance({ describe, expect, it }, "SqliteStorage on a prefixed Durable Object", async (use) =>
	use(await openDurableObjectSqliteStorage(durableObjectStorage(), { prefix: "pi_" })),
);

describe("Durable Object SQLite adapter", () => {
	it("keeps schema names unprefixed by default", async () => {
		const sqlite = new DatabaseSync(":memory:");
		await openDurableObjectSqliteStorage(durableObjectStorage(sqlite));
		expect(sqlite.prepare("SELECT version FROM durable_schema").get()).toEqual({ version: 2 });
		expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'pi_durable_schema'").get()).toBeUndefined();
	});

	it("prefixes pi's tables and indexes without changing host tables", async () => {
		const sqlite = new DatabaseSync(":memory:");
		const storage = durableObjectStorage(sqlite);
		const database = new DurableObjectSqliteDatabase(storage);
		await database.exec("CREATE TABLE host_notes (text TEXT)");
		await database.exec("CREATE TABLE tasks (text TEXT)");
		await openDurableObjectSqliteStorage(storage, { prefix: "pi_" });
		const names = sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'")
			.all()
			.map((row) => String(row.name));
		expect(names).toContain("host_notes");
		expect(names).toContain("tasks");
		expect(names).not.toContain("pi_host_notes");
		const piNames = names.filter((name) => !["host_notes", "tasks"].includes(name));
		expect(piNames.length).toBeGreaterThan(10);
		expect(piNames.every((name) => name.startsWith("pi_"))).toBe(true);
		expect(piNames).toContain("pi_tasks");
		expect(piNames).toContain("pi_durable_schema");
	});

	it("isolates concurrently opened prefixes on one Durable Object", async () => {
		const storage = durableObjectStorage();
		const [first, second] = await Promise.all([
			openDurableObjectSqliteStorage(storage, { prefix: "first_" }),
			openDurableObjectSqliteStorage(storage, { prefix: "second_" }),
		]);
		const entryId = idFromNumber<EntryId>(2);
		await Promise.all([
			first.commit(
				[
					{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
					{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "first" } },
				],
				() => {},
				BACKGROUND_CONTEXT,
			),
			second.commit(
				[
					{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
					{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "second" } },
				],
				() => {},
				BACKGROUND_CONTEXT,
			),
		]);
		expect((await first.entry(entryId, BACKGROUND_CONTEXT))?.entry.kind).toBe("first");
		expect((await second.entry(entryId, BACKGROUND_CONTEXT))?.entry.kind).toBe("second");
		await Promise.all([first.close(BACKGROUND_CONTEXT), second.close(BACKGROUND_CONTEXT)]);
	});

	it("rejects invalid and reserved prefixes", async () => {
		await expect(openDurableObjectSqliteStorage(durableObjectStorage(), { prefix: "" })).rejects.toThrow("Invalid");
		await expect(openDurableObjectSqliteStorage(durableObjectStorage(), { prefix: "bad-prefix" })).rejects.toThrow(
			"Invalid",
		);
		await expect(openDurableObjectSqliteStorage(durableObjectStorage(), { prefix: "sqlite_pi_" })).rejects.toThrow(
			"reserved",
		);
	});
});
