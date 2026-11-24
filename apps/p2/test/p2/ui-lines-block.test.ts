// LinesBlock in the browser (src/web/Code.tsx): a file's and a patch's lines highlighted in context, so a block comment
// spanning lines is a comment on each of its lines, an added line inside one too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser, browserTests } from "./browser.ts";
import { startFixture } from "./helpers.ts";

/** Each shown line's code as `text` and the classes of the spans holding its words. */
const SHOWN = `[...document.querySelectorAll('.diff-line .diff-code')].map((code) => ({
	text: code.textContent,
	classes: [...new Set([...code.querySelectorAll('span')].flatMap((span) => [...span.classList]))].sort(),
}))`;

test(
	"browser: a block comment's lines in a file and across a patch's added line",
	{ skip: !browserTests, timeout: 60_000 },
	async () => {
		const fixture = await startFixture({ web: true });
		let browser: Browser | undefined;
		try {
			browser = await Browser.start();
			await browser.signIn(fixture.owner);
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.querySelector('.app')");
			await browser.loadFixture("lines-block.ts");
			await browser.wait("typeof window.showFile==='function'");
			await browser.evaluate(
				`window.showFile(${JSON.stringify("/**\n * Answers once: of it answered.\n */\nconst x = 1;\n")}, "local-socket.ts")`,
			);
			await browser.wait("document.querySelectorAll('.diff-line').length === 4");
			type Shown = { text: string; classes: string[] };
			const file = await browser.evaluate<Shown[]>(SHOWN);
			assert.deepEqual(file[1], { text: " * Answers once: of it answered.", classes: ["hljs-comment"] });
			assert.deepEqual(file[2], { text: " */", classes: ["hljs-comment"] });
			assert(file[3]!.classes.includes("hljs-keyword"));
			const patch = [
				"diff --git a/a.ts b/a.ts",
				"--- a/a.ts",
				"+++ b/a.ts",
				"@@ -1,3 +1,3 @@",
				" /* start",
				"+   if it returns */",
				"-   const old = 1; */",
				" const y = 2;",
				"",
			].join("\n");
			await browser.evaluate(`window.showPatch(${JSON.stringify(patch)}, "a.ts")`);
			await browser.wait("document.querySelector('.diff-line.add')");
			const lines = await browser.evaluate<Shown[]>(SHOWN);
			assert.deepEqual(lines[0], { text: "@@ -1,3 +1,3 @@", classes: [] });
			assert.deepEqual(lines[2], { text: "   if it returns */", classes: ["hljs-comment"] });
			assert.deepEqual(lines[3], { text: "   const old = 1; */", classes: ["hljs-comment"] });
			assert(lines[4]!.classes.includes("hljs-keyword"));
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
