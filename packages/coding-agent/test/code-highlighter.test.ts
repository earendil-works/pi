import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeRenderers } from "../src/core/tools/renderers/write.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { CodeHighlighter, highlightCode, initTheme } from "../src/modes/interactive/theme/theme.ts";
import * as syntaxHighlight from "../src/utils/syntax-highlight.ts";

const tui = { requestRender: () => {} } as unknown as TUI;

describe("CodeHighlighter", () => {
	beforeEach(() => initTheme("dark"));
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("reuses its last result until the code, the theme or the grammars change", async () => {
		const code = 'const page = html`<div class="x">ok</div>`;';
		const highlighter = new CodeHighlighter();
		const first = highlighter.highlight(code, "javascript");
		expect(highlighter.highlight(code, "javascript")).toBe(first);
		expect(highlighter.highlight("const a = 1;", "javascript")).not.toBe(first);

		initTheme("light");
		expect(highlighter.highlight(code, "javascript")).toEqual(highlightCode(code, "javascript"));
		const light = highlighter.highlight(code, "javascript");
		await syntaxHighlight.loadAllHighlightLanguages();
		expect(highlighter.highlight(code, "javascript")).not.toEqual(light);
	});

	it("codemode highlights the script once across progress, timer ticks, expanding and completion", () => {
		vi.useFakeTimers();
		const highlight = vi.spyOn(syntaxHighlight, "highlight");
		const row = new ToolExecutionComponent(
			"codemode",
			"c",
			{ code: "await tools.read({});" },
			{},
			codemodeRenderers,
			tui,
			"/",
		);
		row.setArgsComplete();
		row.markExecutionStarted();
		row.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
		vi.advanceTimersByTime(2_000);
		row.setExpanded(true);
		row.updateResult({ content: [{ type: "text", text: "done" }], details: { calls: [] }, isError: false }, false);
		row.render(80);
		expect(highlight).toHaveBeenCalledTimes(1);
	});

	it("write highlights unchanged first lines and a complete file only once", () => {
		const content = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const row = new ToolExecutionComponent("write", "w", { path: "a.ts", content }, {}, writeRenderers, tui, "/");
		row.updateArgs({ path: "a.ts", content: `${content} //` });
		row.render(80);
		const highlight = vi.spyOn(syntaxHighlight, "highlight");
		// Only the changed last line is highlighted again.
		row.updateArgs({ path: "a.ts", content: `${content} // more` });
		row.render(80);
		expect(highlight).toHaveBeenCalledTimes(1);

		row.setArgsComplete();
		row.setExpanded(true);
		row.setExpanded(false);
		row.render(80);
		expect(highlight).toHaveBeenCalledTimes(2);
	});
});
