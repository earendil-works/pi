import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runInNewContext } from "node:vm";
import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getReadmePath } from "../src/config.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	SessionManager,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { formatReadLineRange } from "../src/core/tools/render-utils.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface HtmlViewer {
	formatReadLineRange: typeof formatReadLineRange;
	getTreeNodeDisplayHtml(entry: SessionMessageEntry): string;
	renderEntry(entry: SessionMessageEntry): string;
}

// Runs the exported viewer's real data loading and renderers, stopping before DOM initialization.
function loadHtmlViewer(html: string): HtmlViewer {
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
	if (!sessionData || !script) throw new Error("Missing exported session data or viewer script");
	return runInNewContext(
		script.replace(
			"marked.use({",
			"return { formatReadLineRange, getTreeNodeDisplayHtml, renderEntry }; marked.use({",
		),
		{
			atob,
			TextDecoder,
			URLSearchParams,
			document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
			window: { location: { search: "" } },
		},
	);
}

// #9887
describe("read line range display", () => {
	let tempDir: string;
	const cases: [unknown, unknown, string][] = [
		[25, 13, ":25-37"],
		["25", "13", ":25-37"],
		[null, "13", ":1-13"],
		["25", null, ":25"],
		[undefined, undefined, ""],
		["abc", 13, ""],
		[25, "", ""],
		[25, "Infinity", ""],
	];

	beforeAll(() => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "pi-read-range-"));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("formats raw read arguments", () => {
		for (const [offset, limit, range] of cases) {
			expect(formatReadLineRange(offset, limit), `${offset}, ${limit}`).toBe(range);
		}
	});

	it.each([
		{ args: { path: "notes.txt", byteOffset: null }, expected: "read notes.txt" },
		{ args: { path: "notes.txt", byteOffset: null, offset: 25, limit: 13 }, expected: "read notes.txt:25-37" },
		{ args: { path: "report.pdf", byteOffset: null, pages: "3-5", format: "text" }, expected: "(pages 3-5, text)" },
		{ args: { path: "https://example.com", byteOffset: null, strategy: "browser" }, expected: "(browser)" },
		{ args: { path: "data.db", byteOffset: null, table: "events" }, expected: "(table events, rows 0+100)" },
		{ args: { path: getReadmePath(), byteOffset: null, offset: 25, limit: 13 }, expected: "README.md:25-37" },
		{ args: { path: "artifact://example/output", byteOffset: 0 }, expected: "(byte 0)" },
		{ args: { path: "artifact://example/output", byteOffset: 17 }, expected: "(byte 17)" },
	])("renders read arguments without treating null as a byte offset: $expected", ({ args, expected }) => {
		const tool = new ToolExecutionComponent(
			"read",
			"call",
			args,
			{},
			createReadToolDefinition(tempDir),
			// The renderer only needs requestRender from the TUI host.
			{ requestRender() {} } as TUI,
			tempDir,
		);
		const rendered = stripVTControlCharacters(tool.render(160).join("\n"));
		expect(rendered).toContain(expected);
		expect(rendered).not.toContain("byte null");
	});

	it("shows string ranges in the TUI, session tree, and HTML export", async () => {
		const args = { path: "notes.txt", offset: "25", limit: "13" };
		const assistant: SessionMessageEntry = {
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "read", arguments: args }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
		};
		const result: SessionMessageEntry = {
			type: "message",
			id: "result",
			parentId: assistant.id,
			timestamp: assistant.timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [],
				isError: false,
				timestamp: 0,
			},
		};
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "range-test",
			timestamp: assistant.timestamp,
			cwd: tempDir,
		} satisfies SessionHeader;
		const sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(sessionPath, `${[header, assistant, result].map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const tool = new ToolExecutionComponent(
			"read",
			"call",
			args,
			{},
			createReadToolDefinition(tempDir),
			// SAFETY: ToolExecutionComponent only calls ui.requestRender(), which this stub implements.
			{ requestRender() {} } as TUI,
			tempDir,
		);
		expect(stripVTControlCharacters(tool.render(120).join("\n"))).toContain("read notes.txt:25-37");

		const tree = new TreeSelectorComponent(
			SessionManager.open(sessionPath).getTree(),
			result.id,
			40,
			() => {},
			() => {},
		);
		expect(tree.getTreeList().render(120).map(stripVTControlCharacters).join("\n")).toContain(
			"[read: notes.txt:25-37]",
		);

		const viewer = loadHtmlViewer(readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8"));
		for (const [offset, limit, range] of cases) {
			expect(viewer.formatReadLineRange(offset, limit), `${offset}, ${limit}`).toBe(range);
		}
		expect(viewer.getTreeNodeDisplayHtml(result)).toBe('<span class="tree-role-tool">[read: notes.txt:25-37]</span>');
		expect(viewer.renderEntry(assistant)).toContain('<span class="line-numbers">:25-37</span>');
	});
});
