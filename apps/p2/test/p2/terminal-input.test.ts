import assert from "node:assert/strict";
import { test } from "node:test";
import { typedChange } from "../../plugins/terminals/terminal-input.ts";

// On Android every key of an on-screen keyboard arrives as keydown 229; the terminal types what changed in its textarea.
test("terminal input: changes of the textarea as Backspaces and text", () => {
	// Committed text and a composition growing word by word.
	assert.deepEqual(typedChange("", "ls"), { deleted: 0, inserted: "ls" });
	assert.deepEqual(typedChange("echo d", "echo de"), { deleted: 0, inserted: "e" });
	// Backspace, inside a composition or through deleteContentBackward.
	assert.deepEqual(typedChange("echo de", "echo d"), { deleted: 1, inserted: "" });
	// Autocorrect replaces the word before the cursor: retype from the first changed character.
	assert.deepEqual(typedChange("teh", "the "), { deleted: 2, inserted: "he " });
	assert.deepEqual(typedChange("git stauts ", "git status "), { deleted: 4, inserted: "tus " });
	// Double space becomes a period.
	assert.deepEqual(typedChange("hi  ", "hi. "), { deleted: 2, inserted: ". " });
	// Characters, not UTF-16 units: one Backspace for an emoji.
	assert.deepEqual(typedChange("ok 👍", "ok "), { deleted: 1, inserted: "" });
	assert.deepEqual(typedChange("a", "a😀b"), { deleted: 0, inserted: "😀b" });
	// A newline (voice input) is Enter.
	assert.deepEqual(typedChange("", "one\ntwo"), { deleted: 0, inserted: "one\rtwo" });
	assert.deepEqual(typedChange("x", "x"), { deleted: 0, inserted: "" });
});
