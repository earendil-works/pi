import type { Component } from "@earendil-works/pi-tui";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { ansiLinesToHtml } from "../src/core/export-html/ansi-to-html.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

describe("export HTML tool output whitespace", () => {
	it("preserves whitespace for plain-text tool output lines without preserving template whitespace", () => {
		const css = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

		expect(css).toMatch(
			/\.output-preview > div:not\(\.expand-hint\),\s*\.output-full > div:not\(\.expand-hint\) \{[\s\S]*?white-space:\s*pre-wrap;/,
		);
		expect(css).toMatch(/\.ansi-line\s*\{[\s\S]*?white-space:\s*pre;/);
		expect(css).not.toMatch(/\.output-preview,\s*\.output-full\s*\{[\s\S]*?white-space:\s*pre-wrap;/);
	});

	it("does not insert source whitespace between ANSI-rendered lines", () => {
		expect(ansiLinesToHtml(["one", "two"])).toBe('<div class="ansi-line">one</div><div class="ansi-line">two</div>');
	});

	it("trims TUI spacing lines from custom tool result HTML", () => {
		const component: Component = { render: () => ["", "\u001b[31mone\u001b[0m", "two", ""], invalidate: () => {} };
		const tool = {
			name: "custom",
			label: "custom",
			description: "custom",
			renderResult: () => component,
		} as unknown as ToolDefinition;
		const renderer = createToolHtmlRenderer({
			getToolDefinition: () => tool,
			theme: {} as Theme,
			cwd: "/tmp",
		});

		expect(renderer.renderResult("id", "custom", [], undefined, false)?.expanded).toBe(
			'<div class="ansi-line"><span style="color:#800000">one</span></div><div class="ansi-line">two</div>',
		);
	});
});
