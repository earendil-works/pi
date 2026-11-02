// Document handles (slice 6a §4): keyed handles' reads, watches and `at(key)`, and sealed handles refusing every use.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type KeyedHandle, type SingletonHandle } from "../../../src/next/documents/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
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
