import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { IndexedDbCredentialStore } from "../src/credential-store.ts";
import { freshDatabase, memoryLocks } from "./helpers.ts";

const key = (value: string): Credential => ({ type: "api_key", key: value });

describe("IndexedDbCredentialStore", () => {
	it("stores, lists and deletes credentials", async () => {
		const { database } = await freshDatabase();
		const store = new IndexedDbCredentialStore(database, "test", memoryLocks());

		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.modify("anthropic", async () => key("one"))).toEqual(key("one"));
		expect(await store.read("anthropic")).toEqual(key("one"));
		expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);

		// Returning undefined leaves the credential as it is.
		expect(await store.modify("anthropic", async () => undefined)).toEqual(key("one"));

		await store.delete("anthropic");
		expect(await store.read("anthropic")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	it("serializes modify across stores that share a lock manager, like tabs of one origin", async () => {
		const { database } = await freshDatabase();
		const locks = memoryLocks();
		const tabA = new IndexedDbCredentialStore(database, "test", locks);
		const tabB = new IndexedDbCredentialStore(database, "test", locks);
		let releaseA!: () => void;
		const aHolds = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const seenByB: (Credential | undefined)[] = [];
		const first = tabA.modify("xai", async () => {
			await aHolds;
			return key("refreshed-by-a");
		});
		const second = tabB.modify("xai", async (current) => {
			seenByB.push(current);
			return undefined;
		});
		releaseA();
		await Promise.all([first, second]);

		// B ran after A had written, so it saw A's refresh instead of spending the same token again.
		expect(seenByB).toEqual([key("refreshed-by-a")]);
	});

	it("cancels only the wait for the lock", async () => {
		const { database } = await freshDatabase();
		const locks = memoryLocks();
		const store = new IndexedDbCredentialStore(database, "test", locks);
		let release!: () => void;
		let entered!: () => void;
		const inside = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const holding = store.modify(
			"meta",
			() =>
				new Promise<Credential>((resolve) => {
					release = () => resolve(key("held"));
					entered();
				}),
		);
		await inside;
		const controller = new AbortController();
		const waiting = store.modify("meta", async () => key("never"), { signal: controller.signal });
		controller.abort(new Error("gave up"));
		await expect(waiting).rejects.toThrow("gave up");

		release();
		expect(await holding).toEqual(key("held"));
		expect(await store.read("meta")).toEqual(key("held"));
	});
});
