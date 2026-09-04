import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INITIAL_SCHEMA_SQL } from "../src/sqlite/migrations/schema.ts";

describe("SQLite initial schema", () => {
	it("embeds 001_initial.sql so Workers can apply it without filesystem reads", async () => {
		const onDisk = await readFile(
			fileURLToPath(new URL("../src/sqlite/migrations/001_initial.sql", import.meta.url)),
			"utf8",
		);
		expect(INITIAL_SCHEMA_SQL).toBe(onDisk);
	});
});
