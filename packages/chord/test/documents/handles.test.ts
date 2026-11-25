// Document handles (slice 6a §4): keyed handles' reads, watches and `at(key)`, host-keyed handles taking addresses,
// and sealed handles refusing every use.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { type Address, hostKind, obj, str } from "../../src/contracts/index.ts";
import { defineState, type KeyedHandle, type SingletonHandle } from "../../src/documents/index.ts";
import { ChordObject } from "../../src/host/object.ts";
import type { Watchable } from "../../src/watch.ts";
import { instancesOf, rejection, restartable } from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

const Body = defineState("body", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "" }) });
const Notes = defineState("notes", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "" }),
	keyed: true,
});

/** The keys a keyed handle lists. */
async function keysOf(handle: KeyedHandle<{ text: string }>): Promise<string[]> {
	const keys: string[] = [];
	for await (const key of handle.keys(context)) keys.push(key);
	return keys;
}

describe("keyed handles", () => {
	it("list keys in code point order, not UTF-16 order", async () => {
		let notes: KeyedHandle<{ text: string }> | undefined;
		await restartable(objects, (_, self) => {
			notes = self.state(Notes);
		});
		// U+FF5E sorts before U+1F600 by code point; as UTF-16 its unit 0xFF5E sorts after the surrogate 0xD83D.
		for (const key of ["\u{1F600}", "\uFF5E", "b", "a"])
			await notes!.change(
				key,
				(d) => {
					d.text = key;
				},
				context,
			);
		expect(await keysOf(notes!)).toEqual(["a", "b", "\uFF5E", "\u{1F600}"]);
		expect(await notes!.get("\uFF5E", context)).toEqual({ text: "\uFF5E" });
	});
});

describe("sealed handles", () => {
	it("still read synchronously and from memory; changes and retirements are refused released", async () => {
		let body: SingletonHandle<{ text: string }> | undefined;
		let notes: KeyedHandle<{ text: string }> | undefined;
		const { fail } = await restartable(objects, (_, self) => {
			body = self.state(Body);
			notes = self.state(Notes);
		});
		await body!.change((d) => {
			d.text = "x";
		}, context);
		await notes!.change(
			"k",
			(d) => {
				d.text = "y";
			},
			context,
		);
		fail();
		expect(body!.value).toEqual({ text: "x" });
		expect(await notes!.get("k", context)).toEqual({ text: "y" });
		expect(await keysOf(notes!)).toEqual(["k"]);
		const released = { code: "released", reason: "ended", message: "app.restartable(1): ended" };
		expect(await rejection(body!.change(() => {}, context))).toEqual(released);
		expect(await rejection(body!.retire(context))).toEqual(released);
		expect(await rejection(notes!.change("k", () => {}, context))).toEqual(released);
		expect(await rejection(notes!.retire("k", context))).toEqual(released);
	});
});

describe("host-keyed handles", () => {
	const Session = hostKind("session", { id: str() });
	const Meta = defineState("meta", {
		schema: obj({ text: str() }),
		version: 1,
		initial: () => ({ text: "" }),
		keyed: Session,
	});

	it("take and list addresses of their kind, stored by their keys", async () => {
		let meta: KeyedHandle<{ text: string }, Address<typeof Session>> | undefined;
		let pinned: Watchable<{ text: string }> | undefined;
		await restartable(objects, (_, self) => {
			meta = self.state(Meta);
			pinned = meta.at(Session({ id: "S1" }));
		});
		for (const [id, text] of [
			["S1", "one"],
			["S2", "two"],
		]) {
			await meta!.change(
				Session({ id: id! }),
				(d) => {
					d.text = text!;
				},
				context,
			);
		}
		expect(await meta!.get(Session({ id: "S2" }), context)).toEqual({ text: "two" });
		const keys: Address<typeof Session>[] = [];
		for await (const key of meta!.keys(context)) keys.push(key);
		expect(keys).toEqual([Session({ id: "S1" }), Session({ id: "S2" })]);
		expect(await pinned!.watch(context).then((watch) => watch.value)).toEqual({ text: "one" });
		expect((await meta!.watch(Session({ id: "S1" }), context))?.value).toEqual({ text: "one" });
		await meta!.retire(Session({ id: "S1" }), context);
		expect(await meta!.get(Session({ id: "S1" }), context)).toBeUndefined();
	});

	it("refuse strings and addresses of another kind, through the handle and in a transaction", async () => {
		let meta: KeyedHandle<{ text: string }, Address<typeof Session>> | undefined;
		let tx: ((key: unknown) => Promise<unknown>) | undefined;
		await restartable(objects, (_, self) => {
			meta = self.state(Meta);
			tx = (key) => self.tx(async (t) => t.draft(meta!, key as never), context);
		});
		const refused = { code: "invalid", reason: "args", message: "meta: key: expected an address of session" };
		expect(await rejection(meta!.get("session|S1" as never, context))).toMatchObject(refused);
		expect(
			await rejection(meta!.change({ kind: "user", params: { id: "S1" } } as never, () => {}, context)),
		).toMatchObject(refused);
		expect(await rejection(tx!("session|S1"))).toMatchObject(refused);
		expect(() => meta!.at("session|S1" as never)).toThrow("expected an address of session");
		// The empty key and an omitted one are no addresses either (they never reach the store as `host: ""`).
		expect(await rejection(meta!.change("" as never, () => {}, context))).toMatchObject(refused);
		expect(await rejection(tx!(""))).toMatchObject(refused);
		expect(await rejection(tx!(undefined))).toMatchObject(refused);
	});
});
