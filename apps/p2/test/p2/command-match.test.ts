// The command menu's scorer (src/web/command-menu/match.ts): word starts and contiguous runs rank first, every word of
// the query must match, a command matches by title or keyword, scattered matches inside words and missing characters do not match, ties keep their order.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Command } from "../../src/runtime/web-core.ts";
import { commandScore, matchScore, rankBy } from "../../src/web/command-menu/match.ts";

const rank = (query: string, titles: readonly string[]) => rankBy(titles, (title) => matchScore(query, title));

describe("matchScore", () => {
	test("word starts beat the same letters inside words", () => {
		assert.ok(matchScore("ns", "New session") > 0);
		assert.ok(matchScore("arch", "Archive session") > matchScore("arch", "Search sessions"));
		assert.deepEqual(rank("ns", ["Rename session", "New session"]), ["New session"]);
	});

	test("contiguous runs beat scattered ones", () => {
		assert.ok(matchScore("sess", "Switch session") > matchScore("sess", "Set default model sss"));
		assert.deepEqual(rank("mod", ["Set default model", "Change model…", "Move location…"]), [
			"Change model…",
			"Set default model",
		]);
	});

	test("a camel-case capital starts a word", () => {
		assert.ok(matchScore("mi", "modelId") > matchScore("mi", "medium"));
	});

	test("matching is case-insensitive", () => {
		assert.equal(matchScore("ARCH", "Archive session"), matchScore("arch", "archive session"));
	});

	test("every word of the query must match, in any order", () => {
		assert.ok(matchScore("sess arch", "Archive session") > 0);
		assert.equal(matchScore("arch model", "Archive session"), 0);
	});

	test("a command matches by its title or a keyword", () => {
		const archive: Command = {
			title: "Archive session",
			group: "Session",
			order: 10,
			keywords: ["delete", "hide"],
			action: { kind: "run", run: () => {} },
		};
		assert.ok(commandScore("del", archive) > 0);
		assert.equal(commandScore("arch", archive), matchScore("arch", "Archive session"));
		assert.equal(commandScore("rename", archive), 0);
	});

	test("no match: missing characters, scattered inside words, an empty query", () => {
		assert.equal(matchScore("xyz", "Archive session"), 0);
		assert.equal(matchScore("ce", "Archive session"), 0);
		assert.equal(matchScore("", "Archive session"), 0);
		assert.equal(matchScore("  ", "Archive session"), 0);
		assert.equal(matchScore("a", ""), 0);
	});

	test("a substring inside a word matches", () => {
		assert.ok(matchScore("chive", "Archive session") > 0);
	});

	test("ties keep their order", () => {
		assert.deepEqual(rank("s", ["Session b", "Session a"]), ["Session b", "Session a"]);
	});
});
