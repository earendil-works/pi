import assert from "node:assert";
import { describe, it } from "node:test";
import { CellBuffer } from "../src/v2/cell-buffer.ts";
import { DEFAULT_TEXT_STYLE, type StyledLine, type TextStyle } from "../src/v2/styles.ts";

function line(text: string, style: TextStyle = DEFAULT_TEXT_STYLE): StyledLine {
	return [{ text, style }];
}

function assertStructurallyValid(buffer: CellBuffer): void {
	for (let row = 0; row < buffer.height; row++) {
		for (let column = 0; column < buffer.width; column++) {
			const cell = buffer.get(row, column);
			if (cell.cluster === "") {
				assert.ok(column > 0, "continuation cannot occupy column zero");
				assert.strictEqual(buffer.get(row, column - 1).width, 2);
			}
			if (cell.width === 2) {
				assert.ok(column + 1 < buffer.width, "wide cell cannot cross the right edge");
				assert.strictEqual(buffer.get(row, column + 1).cluster, "");
			}
		}
	}
}

describe("CellBuffer putText", () => {
	it("stores grapheme clusters, wide continuations, styles, and links", () => {
		const buffer = new CellBuffer(8, 1);
		const style = { ...DEFAULT_TEXT_STYLE, bold: true };
		buffer.putText(0, 0, [{ text: "a🙂", style, link: "https://example.com" }]);
		assert.deepStrictEqual(buffer.get(0, 0), {
			cluster: "a",
			width: 1,
			styleId: 1,
			linkId: 1,
		});
		assert.strictEqual(buffer.get(0, 1).cluster, "🙂");
		assert.strictEqual(buffer.get(0, 1).width, 2);
		assert.strictEqual(buffer.get(0, 2).cluster, "");
		assert.strictEqual(buffer.styles.get(1).bold, true);
		assert.strictEqual(buffer.links.get(1), "https://example.com");
		assertStructurallyValid(buffer);
	});

	it("clips wide graphemes instead of crossing a region boundary", () => {
		const buffer = new CellBuffer(6, 2);
		const region = buffer.region(1, 0, 3, 1);
		region.putText(2, 0, line("界"));
		assert.strictEqual(buffer.get(0, 3).cluster, " ");
		assert.strictEqual(buffer.get(0, 4).cluster, " ");
		region.putText(-1, 0, line("界a"));
		assert.strictEqual(buffer.get(0, 1).cluster, " ");
		assert.strictEqual(buffer.get(0, 2).cluster, "a");
		assertStructurallyValid(buffer);
	});

	it("clears both halves when overwriting a wide glyph", () => {
		const buffer = new CellBuffer(4, 1);
		buffer.putText(0, 0, line("界"));
		buffer.putText(1, 0, line("x"));
		assert.strictEqual(buffer.get(0, 0).cluster, " ");
		assert.strictEqual(buffer.get(0, 1).cluster, "x");
		assertStructurallyValid(buffer);
	});

	it("never writes outside randomized clipped regions", () => {
		const clusters = ["a", "界", "🙂", "👨‍👩‍👧‍👦", "é", "ำ", "\t"];
		let state = 91;
		for (let sample = 0; sample < 500; sample++) {
			const buffer = new CellBuffer(12, 5);
			const x = sample % 12;
			const y = sample % 5;
			const width = sample % 8;
			const height = sample % 4;
			let text = "";
			for (let index = 0; index < 20; index++) {
				state = (state * 1664525 + 1013904223) >>> 0;
				text += clusters[state % clusters.length];
			}
			buffer.region(x, y, width, height).putText((sample % 9) - 4, (sample % 5) - 2, line(text));
			for (let row = 0; row < buffer.height; row++) {
				for (let column = 0; column < buffer.width; column++) {
					if (row < y || row >= y + height || column < x || column >= x + width) {
						assert.strictEqual(buffer.get(row, column).cluster, " ");
					}
				}
			}
			assertStructurallyValid(buffer);
		}
	});
});

describe("CellBuffer diff", () => {
	it("expands damage to complete wide glyphs", () => {
		const front = new CellBuffer(5, 1);
		front.putText(0, 0, line("界"));
		const back = front.clone();
		back.putText(1, 0, line("x"));
		const runs = back.diff(front);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0]?.column, 0);
		assert.strictEqual(runs[0]?.cells.length, 2);
	});

	it("round-trips randomized frames exactly", () => {
		const clusters = ["a", "b", "界", "🙂", "👩‍💻", "é", " "];
		let state = 1234;
		const front = new CellBuffer(24, 8);
		for (let frame = 0; frame < 300; frame++) {
			const back = front.clone();
			for (let write = 0; write < 12; write++) {
				state = (state * 1103515245 + 12345) >>> 0;
				const row = state % back.height;
				state = (state * 1103515245 + 12345) >>> 0;
				const column = state % back.width;
				state = (state * 1103515245 + 12345) >>> 0;
				back.putText(column, row, line(clusters[state % clusters.length]!));
			}
			front.applyDamage(back.diff(front));
			assert.ok(front.equals(back), `damage did not reproduce frame ${frame}`);
			assertStructurallyValid(front);
		}
	});
});
