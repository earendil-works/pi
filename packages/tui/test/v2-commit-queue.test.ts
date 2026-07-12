import assert from "node:assert";
import { describe, it } from "node:test";
import { styledLineToAnsi } from "../src/v2/ansi.ts";
import { LedgerCommitQueue } from "../src/v2/commit-queue.ts";
import type { LedgerCommit } from "../src/v2/ledger.ts";
import { DEFAULT_TEXT_STYLE, plainLine, type StyledLine } from "../src/v2/styles.ts";

function commit(blockId: string, startLine: number, lines: StyledLine[], final = true): LedgerCommit {
	return { blockId, startLine, lines, final };
}

describe("LedgerCommitQueue", () => {
	it("serializes committed lines once and drains them in order", () => {
		const queue = new LedgerCommitQueue();
		queue.enqueue([commit("a", 0, [plainLine("one"), plainLine("two")])], 20);
		queue.enqueue([commit("b", 0, [plainLine("three")])], 20);
		assert.strictEqual(queue.pending, 3);
		assert.deepStrictEqual(queue.flush(), [
			styledLineToAnsi(plainLine("one")),
			styledLineToAnsi(plainLine("two")),
			styledLineToAnsi(plainLine("three")),
		]);
		assert.strictEqual(queue.pending, 0);
		assert.deepStrictEqual(queue.flush(), []);
	});

	it("applies width safety by hard wrapping long lines", () => {
		const queue = new LedgerCommitQueue();
		queue.enqueue([commit("a", 0, [plainLine("abcdef")])], 4);
		const flushed = queue.flush();
		assert.deepStrictEqual(flushed, [
			styledLineToAnsi([{ text: "abcd", style: DEFAULT_TEXT_STYLE }]),
			styledLineToAnsi([{ text: "ef", style: DEFAULT_TEXT_STYLE }]),
		]);
	});

	it("preserves commit order across interleaved blocks", () => {
		const queue = new LedgerCommitQueue();
		queue.enqueue(
			[commit("a", 0, [plainLine("a0")]), commit("b", 0, [plainLine("b0")]), commit("a", 1, [plainLine("a1")])],
			20,
		);
		assert.deepStrictEqual(queue.flush(), [
			styledLineToAnsi(plainLine("a0")),
			styledLineToAnsi(plainLine("b0")),
			styledLineToAnsi(plainLine("a1")),
		]);
	});
});
