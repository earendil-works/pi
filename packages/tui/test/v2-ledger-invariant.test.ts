import assert from "node:assert";
import { describe, it } from "node:test";
import { ansiTextRenderer, plainTextRenderer } from "../src/v2/blocks.ts";
import {
	type BlockRenderer,
	type CommitFrontier,
	CompletedLineFrontier,
	ConservativeMarkdownFrontier,
	LedgerStore,
} from "../src/v2/ledger.ts";
import type { StyledLine } from "../src/v2/styles.ts";

const WIDTH = 40;

/**
 * Drives a block through an update sequence and returns the concatenation of every committed segment
 * plus a fresh render of the final model. The strengthened §4 invariant: these must be identical, so
 * any renderer/frontier that rewrites an already-committed prefix is caught here.
 */
function collectCommits(
	renderer: BlockRenderer<string, undefined>,
	frontier: CommitFrontier<string> | undefined,
	updates: string[],
	finalModel: string,
): { committed: StyledLine[]; finalRender: StyledLine[] } {
	const store = new LedgerStore<undefined>();
	const handle = store.addBlock({ id: "block", model: updates[0] ?? "", renderer, frontier });
	const committed: StyledLine[] = [];
	for (const update of updates) {
		handle.update(update);
		for (const commit of store.advance(WIDTH, undefined)) committed.push(...commit.lines);
	}
	handle.finalize(finalModel);
	for (const commit of store.advance(WIDTH, undefined)) committed.push(...commit.lines);
	return { committed, finalRender: renderer.render(finalModel, WIDTH, undefined) };
}

describe("ledger commit invariant", () => {
	it("streaming markdown commits concatenate to the final render", () => {
		const finalModel = "# Title\n\nFirst paragraph.\n\nSecond paragraph tail";
		const { committed, finalRender } = collectCommits(
			plainTextRenderer,
			new ConservativeMarkdownFrontier(),
			["# Title\n\nFirst para", "# Title\n\nFirst paragraph.\n\nSecond", finalModel],
			finalModel,
		);
		assert.deepStrictEqual(committed, finalRender);
	});

	it("append-only tool output commits concatenate to the final render", () => {
		const finalModel = "step 1\nstep 2\nstep 3\n";
		const { committed, finalRender } = collectCommits(
			ansiTextRenderer,
			new CompletedLineFrontier(),
			["step 1\n", "step 1\nstep 2\n", finalModel],
			finalModel,
		);
		assert.deepStrictEqual(committed, finalRender);
	});

	it("block-stable content (no frontier, finalized) commits exactly the final render", () => {
		const finalModel = "user asked a question\nover two lines";
		const { committed, finalRender } = collectCommits(
			plainTextRenderer,
			undefined,
			["ignored open model"],
			finalModel,
		);
		assert.deepStrictEqual(committed, finalRender);
	});

	it("fails loudly when a renderer rewrites an already-committed prefix", () => {
		// Pathological renderer: line 0 encodes the total line count, so committing an early prefix
		// bakes in a stale count that the final render contradicts.
		const rewritingRenderer: BlockRenderer<string, undefined> = {
			render(model: string): StyledLine[] {
				const lines = model.replace(/\n$/, "").split("\n");
				return [`lines=${lines.length}`, ...lines].map((text) => [
					{ text, style: { ...plainTextRenderer.render("", WIDTH, undefined)[0]![0]!.style } },
				]);
			},
		};
		assert.throws(() => {
			const { committed, finalRender } = collectCommits(
				rewritingRenderer,
				new CompletedLineFrontier(),
				["a\n", "a\nb\n"],
				"a\nb\nc",
			);
			assert.deepStrictEqual(committed, finalRender);
		}, /Ledger frontier retreated|Expected values to be strictly deep-equal/);
	});
});
