// Hint words for the reader's device: the pointer kind from the any-pointer media queries, and the verbs and key
// labels hints use for it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { moreVerb, pointerKind, pressVerb, upperFirst } from "../../src/web/input-hints.ts";

function withPointers(pointers: { coarse: boolean; fine: boolean }, run: () => void): void {
	const original = globalThis.matchMedia;
	globalThis.matchMedia = ((query: string) => ({
		matches: query.includes("coarse") ? pointers.coarse : query.includes("fine") ? pointers.fine : false,
	})) as typeof matchMedia;
	try {
		run();
	} finally {
		globalThis.matchMedia = original;
	}
}

test("a phone taps, a desktop clicks, a touch laptop does both", () => {
	const cases = [
		{ pointers: { coarse: true, fine: false }, kind: "touch", press: "tap", more: "long-press" },
		{ pointers: { coarse: false, fine: true }, kind: "mouse", press: "click", more: "right-click" },
		{
			pointers: { coarse: true, fine: true },
			kind: "both",
			press: "click or tap",
			more: "right-click or long-press",
		},
		// No pointer at all (a TV's remote): hints name clicks.
		{ pointers: { coarse: false, fine: false }, kind: "mouse", press: "click", more: "right-click" },
	] as const;
	for (const { pointers, kind, press, more } of cases) {
		withPointers(pointers, () => {
			assert.equal(pointerKind(), kind);
			assert.equal(pressVerb(kind), press);
			assert.equal(moreVerb(kind), more);
		});
	}
	assert.equal(upperFirst("click or tap"), "Click or tap");
});
