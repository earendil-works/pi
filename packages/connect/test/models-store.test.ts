import { describe, expect, it } from "vitest";
import { IndexedDbModelsStore } from "../src/models-store.ts";
import { freshDatabase } from "./helpers.ts";

describe("IndexedDbModelsStore", () => {
	it("keeps a provider's catalog until it is deleted", async () => {
		const { database } = await freshDatabase();
		const store = new IndexedDbModelsStore(database);
		const entry = { models: [], checkedAt: 1, etag: '"catalog-1"' };

		expect(await store.read("google")).toBeUndefined();
		await store.write("google", entry);
		expect(await store.read("google")).toEqual(entry);
		await store.delete("google");
		expect(await store.read("google")).toBeUndefined();
	});
});
