import { describe, expect, it } from "vitest";
import { ConnectDatabase } from "../src/database.ts";
import { freshDatabase } from "./helpers.ts";

describe("ConnectDatabase", () => {
	it("keeps values per store across connections", async () => {
		const { database, factory, name } = await freshDatabase();
		await database.put("credentials", "radius", { type: "api_key", key: "k" });
		await database.put("documents", "radius", "not a credential");
		database.close();

		const reopened = await ConnectDatabase.open(name, factory);
		expect(await reopened.get("credentials", "radius")).toEqual({ type: "api_key", key: "k" });
		expect(await reopened.get("documents", "radius")).toBe("not a credential");
		expect(await reopened.keys("credentials")).toEqual(["radius"]);
		await reopened.delete("credentials", "radius");
		expect(await reopened.keys("credentials")).toEqual([]);
	});
});
