// Tests of claims (slice 6b "owner names and claims", "claims per table and per document namespace"): a table by its
// SQL name and documents by owner and namespace, once per store; released by their claimant's end; none taken while a
// batch applies.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { Claims } from "../../../src/next/store/claims.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { loaded, memoryStore } from "../support.ts";

describe("claims", () => {
	it("refuse a second claimant of a table or of an owner's namespace; one claimant may claim again", () => {
		const claims = new Claims();
		const a = { label: "A" };
		const b = { label: "B" };
		claims.table("x:edits", a);
		claims.table("x:edits", a);
		claims.documents("x", "chord", a);
		expect(() => claims.table("x:edits", b)).toThrow("claimed by A");
		expect(() => claims.documents("x", "chord", b)).toThrow("claimed by A");
		// Another namespace of the same owner, another table: no collision.
		claims.documents("x", "session", b);
		claims.table("x:entries", b);
		expect(claims.held).toBe(true);
		claims.release(a);
		claims.table("x:edits", b);
		claims.release(b);
		expect(claims.held).toBe(false);
	});

	it("are refused while locked (a batch applies), taken again once unlocked", () => {
		const claims = new Claims();
		const owner = { label: "A" };
		const unlock = claims.lock();
		expect(() => claims.table("x:edits", owner)).toThrow("while a batch applies");
		expect(() => claims.documents("x", "chord", owner)).toThrow("while a batch applies");
		expect(claims.held).toBe(false);
		unlock();
		claims.table("x:edits", owner);
		expect(claims.held).toBe(true);
	});

	it("an object claims its tables and documents when it declares them, and releases them at its end", async () => {
		const store = await memoryStore();
		const Note = defineState("note", {
			schema: obj({ n: int() }),
			version: 1,
			initial: () => ({ n: 0 }),
			persist: true,
			checkpointWhen: () => true,
		});
		const Edits = defineTable("edits", { version: 1, columns: { id: str() }, key: ["id"] });
		const Notes = local("notes.store", { version: 1, params: {}, members: {} });
		const { host } = await loaded(
			(h) =>
				h.serve(Notes, (_, self) => {
					self.state(Note);
					self.table(Edits);
					return {};
				}),
			{ store },
		);
		await host.get(Notes, {}, context);
		expect(() => store.claims.table("notes.store:edits", { label: "other" })).toThrow("claimed by notes.store");
		expect(() => store.claims.documents("notes.store", "chord", { label: "other" })).toThrow("claimed");
		await host.close(context);
		expect(store.claims.held).toBe(false);
		store.claims.table("notes.store:edits", { label: "other" });
	});
});
