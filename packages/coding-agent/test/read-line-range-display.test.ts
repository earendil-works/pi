import { stripVTControlCharacters } from "node:util";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

function renderReadCall(args: unknown): string {
	const context = {
		args,
		toolCallId: "tc-1",
		invalidate: () => {},
		lastComponent: new Text("", 0, 0) as Component,
		state: undefined,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
	};
	const component = readRenderers.renderCall!(args as any, theme, context as any);
	return stripVTControlCharacters((component as Text).render(400).join("\n"));
}

describe("read line range display", () => {
	it("renders numeric offset/limit as a line range", () => {
		expect(renderReadCall({ path: "notes.txt", offset: 25, limit: 13 })).toContain(":25-37");
	});

	it("coerces string offset/limit instead of concatenating them (#9887)", () => {
		const text = renderReadCall({ path: "notes.txt", offset: "25", limit: "13" });
		expect(text).toContain(":25-37");
		expect(text).not.toContain(":25-2512");
	});

	it("treats a null limit from strict tool schemas as absent", () => {
		expect(renderReadCall({ path: "notes.txt", offset: 25, limit: null })).toContain(":25");
		expect(renderReadCall({ path: "notes.txt", offset: 25, limit: null })).not.toContain(":25-24");
	});
});

function userMessage(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function readToolCallAssistant(id: string, parentId: string | null, args: JsonObject): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `tc-${id}`, name: "read", arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
	};
}

function readToolResult(id: string, parentId: string | null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `tc-${parentId}`,
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		},
	} as unknown as SessionMessageEntry;
}

function buildTree(entries: Array<SessionEntry>): any[] {
	const nodes = entries.map((entry) => ({ entry, children: [] as any[] }));
	const byId = new Map<string, any>();
	for (const node of nodes) byId.set((node.entry as any).id, node);
	const roots: any[] = [];
	for (const node of nodes) {
		const parentId = (node.entry as any).parentId;
		if (parentId === null) {
			roots.push(node);
		} else {
			byId.get(parentId)?.children.push(node);
		}
	}
	return roots;
}

describe("session tree read label", () => {
	it("coerces string offset/limit in the tool result label (#9887)", () => {
		const entries: Array<SessionEntry> = [
			userMessage("user-1", null, "read notes.txt"),
			readToolCallAssistant("asst-1", "user-1", { path: "test.ts", offset: "25", limit: "13" }),
			readToolResult("result-1", "asst-1"),
		];
		const selector = new TreeSelectorComponent(
			buildTree(entries),
			"result-1",
			40,
			() => {},
			() => {},
		);
		const rendered = selector.getTreeList().render(200).map(stripVTControlCharacters).join("\n");
		expect(rendered).toContain("[read: test.ts:25-37]");
		expect(rendered).not.toContain("2512");
	});
});
