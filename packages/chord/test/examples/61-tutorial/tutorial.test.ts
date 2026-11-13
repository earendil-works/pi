// The tutorial's checks (`docs/tutorial/book.md`): every TypeScript, JSON and CSS block of the book is quoted from this
// example's files (`<!-- quote: path -->` above it) and fails here when the file no longer has those lines; the
// example's steps run (`main.ts`, which runs `trace.ts` on its data directory, and `screenshots.ts` with Chromium), and
// every console output the book shows (`<!-- output: main -->`, `<!-- output: screenshots -->`) is among the lines they
// print, in order: the telemetry chapter's traces, `trace.ts`'s reads and the viewer's screenshot too. The terminal's
// output (`<!-- output: tui -->`) is checked when a Node for its sandbox is there (`CHORD_TUI_NODE`, else `node26`).
// The p2 chapter's blocks (`<!-- p2: path -->`) quote p2's sources, which live outside this repository.
// Run from packages/chord:
//   node ../../node_modules/vitest/dist/cli.js --run test/examples/61-tutorial/tutorial.test.ts
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TUI_NODE } from "../../node/tui/support.ts";
import { CHROMIUM } from "../../node/web/browser.ts";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const BOOK = readFileSync(new URL("../../../docs/tutorial/book.md", import.meta.url), "utf8");

/** A fenced block of the book: its language, the marker comment right above it (if any), its text and line. */
type Block = {
	readonly lang: string;
	readonly marker: string | undefined;
	readonly text: string;
	readonly line: number;
};

const BLOCKS = blocksOf(BOOK);

/** Every fenced block of `book`, with the `<!-- … -->` marker on the line before its opening fence. */
function blocksOf(book: string): Block[] {
	const lines = book.split("\n");
	const found: Block[] = [];
	for (let n = 0; n < lines.length; n++) {
		const open = /^```(\w*)$/.exec(lines[n]!);
		if (open === null) continue;
		const end = lines.indexOf("```", n + 1);
		const marker = /^<!-- (.+) -->$/.exec(lines[n - 1] ?? "")?.[1];
		found.push({ lang: open[1]!, marker, text: lines.slice(n + 1, end).join("\n"), line: n + 1 });
		n = end;
	}
	return found;
}

/** The blocks whose marker is `<kind>: <value>`, with the value. */
function marked(kind: string): { readonly block: Block; readonly value: string }[] {
	return BLOCKS.flatMap((block) => {
		const value = block.marker?.startsWith(`${kind}: `) ? block.marker.slice(kind.length + 2) : undefined;
		return value === undefined ? [] : [{ block, value }];
	});
}

/** Fails unless every line of `block` is among `printed`'s lines, in order. */
function expectPrinted(block: Block, printed: string): void {
	const lines = printed.split("\n").map((line) => line.trimEnd());
	let at = 0;
	for (const line of block.text.split("\n")) {
		const found = lines.indexOf(line.trimEnd(), at);
		expect(found, `book.md:${block.line}: not printed (in this order): ${line}`).toBeGreaterThanOrEqual(0);
		at = found + 1;
	}
}

/** Runs one of the example's scripts with `node` from packages/chord: what it printed. */
async function run(node: string, script: string, ...args: string[]): Promise<string> {
	const flags = ["--conditions=source", "--experimental-strip-types", "--no-warnings"];
	const { stdout } = await promisify(execFile)(node, [...flags, join(HERE, script), ...args], {
		cwd: join(HERE, "../../.."),
		timeout: 180_000,
	});
	return stdout;
}

describe("the tutorial's code blocks", () => {
	it("quotes every TypeScript, JSON and CSS block from a file", () => {
		const unquoted = BLOCKS.filter(
			({ lang, marker }) =>
				["ts", "tsx", "json", "css"].includes(lang) &&
				!marker?.startsWith("quote: ") &&
				!marker?.startsWith("p2: "),
		);
		expect(unquoted.map(({ line }) => `book.md:${line}`)).toEqual([]);
	});

	it("matches the example's files", () => {
		const quotes = marked("quote");
		expect(quotes.length).toBeGreaterThan(20);
		for (const { block, value } of quotes) {
			const file = readFileSync(join(HERE, value), "utf8");
			expect(file.includes(block.text), `book.md:${block.line}: ${value} no longer has this block`).toBe(true);
		}
	});
});

describe("the tutorial's steps", () => {
	it("prints what the book shows", { timeout: 200_000 }, async () => {
		const printed = await run(TUI_NODE ?? process.execPath, "main.ts");
		for (const { block } of marked("output").filter(({ value }) => value === "main")) expectPrinted(block, printed);
		if (TUI_NODE === undefined) return;
		for (const { block } of marked("output").filter(({ value }) => value === "tui")) expectPrinted(block, printed);
	});

	it.skipIf(CHROMIUM === undefined)("takes the screenshots", { timeout: 200_000 }, async () => {
		const out = mkdtempSync(join(tmpdir(), "todo-screens-"));
		try {
			const printed = await run(process.execPath, "screenshots.ts", out);
			for (const { block } of marked("output").filter(({ value }) => value === "screenshots")) {
				expectPrinted(block, printed.replaceAll(out, "docs/tutorial/screens"));
			}
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});
});
