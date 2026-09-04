import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

function extractBlock(source: string, startNeedle: string): string {
	const start = source.indexOf(startNeedle);
	if (start < 0) {
		throw new Error(`Could not find ${JSON.stringify(startNeedle)}`);
	}
	let depth = 0;
	let started = false;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") {
			depth++;
			started = true;
		} else if (ch === "}") {
			depth--;
			if (started && depth === 0) {
				return source.slice(start, i + 1);
			}
		}
	}
	throw new Error(`Unclosed block starting at ${JSON.stringify(startNeedle)}`);
}

type CustomMessageFixture = {
	id: string;
	type: "custom_message";
	customType: string;
	content: string;
	display: boolean;
	timestamp?: string;
};

describe("export HTML custom messages", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const templateCss = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");
	const customMessageBlock = extractBlock(templateJs, "if (entry.type === 'custom_message')");

	function renderCustomMessage(entry: CustomMessageFixture): string {
		const render = new Function(
			"entry",
			"escapeHtml",
			"safeMarkedParse",
			`"use strict";
			const tsHtml = "";
			const entryDomId = "entry-" + escapeHtml(entry.id);
			${customMessageBlock}
			return "";`,
		) as (
			entry: CustomMessageFixture,
			escapeHtml: (value: string) => string,
			safeMarkedParse: (value: string) => string,
		) => string;
		return render(
			entry,
			(value) => value,
			(value) => value,
		);
	}

	it("renders custom messages with display:false instead of dropping them", () => {
		// #8896 display is TUI-only; HTML export must include model-visible custom messages
		expect(templateJs).not.toMatch(/if \(entry\.type === 'custom_message' && entry\.display\)/);

		const html = renderCustomMessage({
			id: "i9j0k1l2",
			type: "custom_message",
			customType: "wiki-recall-context",
			content: "recalled wiki pages",
			display: false,
		});

		expect(html).toContain("wiki-recall-context");
		expect(html).toContain("recalled wiki pages");
		expect(html).toContain("hook-message-injected");
		expect(html).toContain("injected into model context");
	});

	it("leaves display:true custom messages unlabeled as injected context", () => {
		// #8896
		const html = renderCustomMessage({
			id: "a1b2c3d4",
			type: "custom_message",
			customType: "session-notice",
			content: "LLM Wiki active",
			display: true,
		});

		expect(html).toContain("session-notice");
		expect(html).toContain("LLM Wiki active");
		expect(html).not.toContain("hook-message-injected");
		expect(html).not.toContain("injected into model context");
	});

	it("styles TUI-hidden custom messages distinctly in the export CSS", () => {
		// #8896
		expect(templateCss).toMatch(/\.hook-message-injected\s*\{/);
		expect(templateCss).toMatch(/\.hook-injected\s*\{/);
	});
});
