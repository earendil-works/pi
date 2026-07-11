import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type BlockRenderer,
	type CommitFrontier,
	CompletedLineFrontier,
	ConservativeMarkdownFrontier,
	conservativeMarkdownStableOffset,
	LedgerStore,
} from "../src/v2/ledger.ts";
import { plainLine, type StyledLine } from "../src/v2/styles.ts";

const textRenderer: BlockRenderer<string, undefined> = {
	render(model) {
		if (model.length === 0) return [];
		const lines = model.split("\n");
		if (model.endsWith("\n")) lines.pop();
		return lines.map(plainLine);
	},
};

function lineText(line: StyledLine): string {
	return line.map((span) => span.text).join("");
}

function seededChunks(text: string, seed: number): string[] {
	let state = seed;
	const chunks: string[] = [];
	let offset = 0;
	while (offset < text.length) {
		state = (state * 1664525 + 1013904223) >>> 0;
		const length = 1 + (state % 7);
		chunks.push(text.slice(offset, offset + length));
		offset += length;
	}
	return chunks;
}

describe("conservativeMarkdownStableOffset", () => {
	it("stops before an unfinished paragraph", () => {
		assert.strictEqual(conservativeMarkdownStableOffset("stable\n\nlive"), 8);
	});

	it("does not split on blank lines inside an open fence", () => {
		const markdown = "before\n\n```ts\none\n\ntwo\n";
		assert.strictEqual(conservativeMarkdownStableOffset(markdown), "before\n\n".length);
	});

	it("advances through a closed fence", () => {
		const markdown = "```ts\none\n\n```\ntail";
		assert.strictEqual(conservativeMarkdownStableOffset(markdown), "```ts\none\n\n```\n".length);
	});
});

describe("LedgerStore", () => {
	it("keeps finalized blocks behind an open predecessor", () => {
		const ledger = new LedgerStore<undefined>();
		const first = ledger.addBlock({
			id: "first",
			model: "open",
			renderer: textRenderer,
			frontier: new ConservativeMarkdownFrontier(),
		});
		ledger.addBlock({ id: "second", model: "done", renderer: textRenderer, state: "final" });
		assert.deepStrictEqual(ledger.advance(80, undefined), []);
		assert.deepStrictEqual(ledger.frontier, { blockIndex: 0, stableLine: 0 });
		first.finalize("open done");
		const commits = ledger.advance(80, undefined);
		assert.deepStrictEqual(
			commits.map((commit) => ({ id: commit.blockId, lines: commit.lines.map(lineText) })),
			[
				{ id: "first", lines: ["open done"] },
				{ id: "second", lines: ["done"] },
			],
		);
		assert.deepStrictEqual(ledger.frontier, { blockIndex: 2, stableLine: 0 });
	});

	it("commits completed tool lines without duplicating prior output", () => {
		const ledger = new LedgerStore<undefined>();
		const block = ledger.addBlock({
			id: "tool",
			model: "one",
			renderer: textRenderer,
			frontier: new CompletedLineFrontier(),
		});
		assert.deepStrictEqual(ledger.advance(80, undefined), []);
		block.update("one\ntwo\npartial");
		assert.deepStrictEqual(ledger.advance(80, undefined)[0]?.lines.map(lineText), ["one", "two"]);
		block.update("one\ntwo\npartial done\n");
		assert.deepStrictEqual(ledger.advance(80, undefined)[0]?.lines.map(lineText), ["partial done"]);
		block.finalize();
		assert.deepStrictEqual(ledger.advance(80, undefined), []);
	});

	it("preserves frontier monotonicity across randomized markdown chunk boundaries", () => {
		const markdown = [
			"alpha paragraph\n\n",
			"```ts\nconst value = 1;\n\nconsole.log(value);\n```\n",
			"- item one\n- item two\n\n",
			"final paragraph",
		].join("");
		for (let seed = 1; seed <= 100; seed++) {
			const ledger = new LedgerStore<undefined>();
			const block = ledger.addBlock({
				id: `markdown-${seed}`,
				model: "",
				renderer: textRenderer,
				frontier: new ConservativeMarkdownFrontier(),
			});
			let source = "";
			let previousStableLine = 0;
			const committed: string[] = [];
			for (const chunk of seededChunks(markdown, seed)) {
				source += chunk;
				block.update(source);
				for (const commit of ledger.advance(80, undefined)) committed.push(...commit.lines.map(lineText));
				assert.ok(ledger.frontier.stableLine >= previousStableLine);
				previousStableLine = ledger.frontier.stableLine;
			}
			block.finalize();
			for (const commit of ledger.advance(80, undefined)) committed.push(...commit.lines.map(lineText));
			assert.deepStrictEqual(committed, textRenderer.render(markdown, 80, undefined).map(lineText));
		}
	});

	it("rejects a frontier that retreats", () => {
		let stable = "one\ntwo\n";
		const frontier: CommitFrontier<string> = {
			stableModel: () => ({ model: stable }),
		};
		const ledger = new LedgerStore<undefined>();
		ledger.addBlock({ id: "bad", model: "ignored", renderer: textRenderer, frontier });
		ledger.advance(80, undefined);
		stable = "one\n";
		assert.throws(() => ledger.advance(80, undefined), /frontier retreated/);
	});
});
