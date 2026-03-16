import assert from "node:assert/strict";
import test from "node:test";
import { getThreadParentTs } from "../src/reply-mode.js";

test("replies in thread for channel mentions", () => {
	assert.equal(getThreadParentTs({ type: "mention", ts: "123.456" }), "123.456");
});

test("does not thread event-triggered runs", () => {
	assert.equal(getThreadParentTs({ type: "mention", ts: "123.456" }, true), null);
});

test("does not thread direct messages", () => {
	assert.equal(getThreadParentTs({ type: "dm", ts: "123.456" }), null);
});
