import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";

const theme = {
	heading: (s: string) => `\x1b[1m${s}\x1b[0m`,
	link: (s: string) => `\x1b[4m${s}\x1b[0m`,
	linkUrl: (s: string) => `\x1b[2m${s}\x1b[0m`,
	code: (s: string) => `\x1b[36m${s}\x1b[0m`,
	codeBlock: (s: string) => `\x1b[36m${s}\x1b[0m`,
	codeBlockBorder: (s: string) => `\x1b[36m${s}\x1b[0m`,
	quote: (s: string) => `\x1b[3m${s}\x1b[0m`,
	quoteBorder: (s: string) => `\x1b[90m${s}\x1b[0m`,
	hr: (s: string) => s,
	listBullet: (s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	italic: (s: string) => `\x1b[3m${s}\x1b[0m`,
	strikethrough: (s: string) => `\x1b[9m${s}\x1b[0m`,
	underline: (s: string) => `\x1b[4m${s}\x1b[0m`,
};

/** Render text through a fresh component (full path) and compare with incremental appends. */
function assertIncrementalMatchesFull(texts: string[], width = 60): void {
	const md = new Markdown("", 1, 0, theme);
	for (const text of texts) {
		md.setText(text);
		const incremental = md.render(width);
		// Full render from scratch must match the incremental output exactly.
		const fresh = new Markdown(text, 1, 0, theme);
		const full = fresh.render(width);
		assert.deepStrictEqual(incremental, full, `incremental != full for ${JSON.stringify(text.slice(-40))}`);
	}
}

function appendOver(text: string, chunkSize: number): string[] {
	const texts: string[] = [];
	let current = "";
	for (let i = 0; i < text.length; i += chunkSize) {
		current += text.slice(i, i + chunkSize);
		texts.push(current);
	}
	return texts;
}

describe("Markdown incremental append rendering", () => {
	it("matches full render for plain prose", () => {
		assertIncrementalMatchesFull(
			appendOver("This is a plain paragraph of text that will be appended word by word.", 4),
		);
	});

	it("matches full render for prose with inline formatting", () => {
		assertIncrementalMatchesFull(
			appendOver(
				"A **bold** word and *italic* and `code` and [a link](https://x.com) and ~~strike~~ and more text.",
				3,
			),
		);
	});

	it("matches full render for paragraphs separated by blank lines", () => {
		assertIncrementalMatchesFull(appendOver("First paragraph.\n\nSecond paragraph with more words.\n\nThird.", 5));
	});

	it("matches full render for an unclosed then closed code fence", () => {
		const stream = appendOver("```ts\nfunction f() {\n  return 1;\n}\n```\n\nTrailing paragraph.", 3);
		assertIncrementalMatchesFull(stream);
	});

	it("matches full render for a code fence that never closes", () => {
		assertIncrementalMatchesFull(appendOver("```py\nprint('hello')\nprint('world')\n", 4));
	});

	it("matches full render for lists", () => {
		assertIncrementalMatchesFull(appendOver("- first item\n- second item\n- third item\n", 3));
	});

	it("matches full render for a paragraph that grows into a table", () => {
		const md = new Markdown("", 1, 0, theme);
		const texts = [
			"| a | b |",
			"| a | b |\n|---|---|",
			"| a | b |\n|---|---|\n| 1 | 2 |",
			"| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
		];
		for (const text of texts) {
			md.setText(text);
			const incremental = md.render(60);
			const full = new Markdown(text, 1, 0, theme).render(60);
			assert.deepStrictEqual(incremental, full, `mismatch for ${JSON.stringify(text)}`);
		}
	});

	it("matches full render for blockquotes", () => {
		assertIncrementalMatchesFull(appendOver("> quoted line one\n> quoted line two\n\nAfter quote.", 4));
	});

	it("matches full render for headings", () => {
		assertIncrementalMatchesFull(appendOver("## A heading\n\nSome body text under it.", 3));
	});

	it("matches full render for wrapping at narrow width", () => {
		const text =
			"A long paragraph with many words that must wrap across several terminal lines when the width is narrow, so wrapping happens in the middle of the text.";
		assertIncrementalMatchesFull(appendOver(text, 5), 25);
	});

	it("matches full render with horizontal padding", () => {
		const md = new Markdown("", 2, 1, theme);
		const texts = appendOver("Padded paragraph text that is long enough to wrap.\n\nSecond paragraph.", 4);
		for (const text of texts) {
			md.setText(text);
			const incremental = md.render(40);
			const full = new Markdown(text, 2, 1, theme).render(40);
			assert.deepStrictEqual(incremental, full, `mismatch for ${JSON.stringify(text)}`);
		}
	});

	it("matches full render when a space token is the tail", () => {
		const md = new Markdown("", 1, 0, theme);
		for (const text of ["para one\n\n", "para one\n\npara two", "para one\n\npara two\n\npara three"]) {
			md.setText(text);
			const incremental = md.render(60);
			const full = new Markdown(text, 1, 0, theme).render(60);
			assert.deepStrictEqual(incremental, full, `mismatch for ${JSON.stringify(text)}`);
		}
	});

	it("matches full render for tabs", () => {
		assertIncrementalMatchesFull(appendOver("line one\twith\ttabs\n\nline two", 3));
	});

	it("matches full render for hr", () => {
		assertIncrementalMatchesFull(appendOver("Before\n\n---\n\nAfter", 2));
	});

	it("matches full render for nested list continuation", () => {
		assertIncrementalMatchesFull(appendOver("- a\n  - nested a1\n  - nested a2\n- b\n", 3));
	});

	it("matches full render for a long randomized stream", () => {
		// Deterministic pseudo-random generator for reproducible tests.
		let seed = 12345;
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const fragments = [
			"word ",
			"**bold** ",
			"`code` ",
			"*it* ",
			"\n",
			"\n\n",
			"- item\n",
			"```\ncode\n```\n",
			"> quote\n",
			"## head\n",
			"| a | b |\n|---|---|\n| 1 | 2 |\n",
			"---\n",
		];
		let text = "";
		const texts: string[] = [];
		for (let i = 0; i < 120; i++) {
			text += fragments[Math.floor(rand() * fragments.length)]!;
			texts.push(text);
		}
		assertIncrementalMatchesFull(texts, 50);
	});

	it("falls back to full render when text is not an extension", () => {
		const md = new Markdown("", 1, 0, theme);
		md.setText("first text");
		md.render(60);
		// Replacement (not extension) must still render correctly.
		md.setText("completely different");
		const result = md.render(60);
		const full = new Markdown("completely different", 1, 0, theme).render(60);
		assert.deepStrictEqual(result, full);
	});

	it("falls back to full render on width change", () => {
		const md = new Markdown("", 1, 0, theme);
		const text = "A paragraph that is long enough to wrap around.";
		md.setText(text);
		const w1 = md.render(30);
		const w2 = md.render(20);
		const full = new Markdown(text, 1, 0, theme).render(20);
		assert.deepStrictEqual(w2, full);
		assert.notDeepStrictEqual(w1, w2);
	});
});

describe("Markdown streaming code blocks", () => {
	const codeTheme = {
		heading: (s: string) => s,
		link: (s: string) => s,
		linkUrl: (s: string) => s,
		code: (s: string) => s,
		codeBlock: (s: string) => `\x1b[90m${s}\x1b[0m`,
		codeBlockBorder: (s: string) => s,
		quote: (s: string) => s,
		quoteBorder: (s: string) => s,
		hr: (s: string) => s,
		listBullet: (s: string) => s,
		bold: (s: string) => s,
		italic: (s: string) => s,
		strikethrough: (s: string) => s,
		underline: (s: string) => s,
		highlightCode: (code: string) => code.split("\n").map((l) => `HL:${l}`),
	};

	it("skips syntax highlighting while streaming, applies it when not streaming", () => {
		const source = "```ts\nconst x = 1;\n```\n";
		const streaming = new Markdown(source, 1, 0, codeTheme, undefined, { streaming: true });
		const plain = streaming.render(40);
		const finished = new Markdown(source, 1, 0, codeTheme, undefined, { streaming: false });
		const highlighted = finished.render(40);
		assert.ok(!plain.join("\n").includes("HL:"), "streaming should not highlight");
		assert.ok(highlighted.join("\n").includes("HL:const x = 1;"), "finished should highlight");
		// code still rendered (not empty) while streaming
		assert.ok(plain.join("\n").includes("const x = 1;"), "streaming still shows code");
	});
});
