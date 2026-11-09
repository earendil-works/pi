// The quiet-tools plugin: one line per tool call; a failed call and an expanded transcript show the full content; its
// `/settings` row (`plugins.quiet-tools.toolCalls`) switches back to the tools' own cards.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { quietTools } from "../../plugins/quiet-tools/tui.ts";
import { validatePrefsPatch } from "../../src/hosts/tui-prefs-save.ts";
import type { TuiSettings } from "../../src/runtime/tui-preferences.ts";
import { TranscriptView } from "../../src/tui/components/transcript.ts";
import { mergeSettings, sanitizeSettings } from "../../src/tui/preferences.ts";
import { ThemeRef } from "../../src/tui/theme/ref.ts";
import { BUILTIN_THEMES, createTheme } from "../../src/tui/theme/theme.ts";
import { resolveToolRenderers } from "../../src/tui/tools/index.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { PLUGIN_TUI_RENDERERS } from "../fixtures/tui-tools.ts";
import { wholeView } from "../fixtures/whole-view.ts";

const plain = (lines: string[]): string => lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
const entry = (id: number, record: Omit<EntryRecord, "id" | "conversationId">): EntryRecord =>
	({ id: id as EntryId, conversationId: ROOT_CONVERSATION_ID, ...record }) as EntryRecord;
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const answer: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "text", text: "Checking." },
		{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm run check\necho done" } },
		{ type: "toolCall", id: "t2", name: "read", arguments: { path: "/work/src/a.ts", offset: 10 } },
		{ type: "toolCall", id: "t3", name: "edit", arguments: { path: "/work/src/b.ts", edits: [] } },
	],
	api: "openai-completions",
	provider: "faux",
	model: "faux-1",
	stopReason: "toolUse",
	timestamp: 2,
	usage,
};
const result = (id: number, toolCallId: string, toolName: string, text: string, isError = false) =>
	entry(id, {
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text }],
				isError,
				durationMs: toolCallId === "t1" ? 2500 : 5,
				timestamp: id,
			} satisfies ToolResultMessage,
		],
	});
const entries = [
	entry(1, { kind: "pi.user", model: [{ role: "user", content: "go", timestamp: 1 }] }),
	entry(2, { kind: "pi.assistant", model: [answer] }),
	result(3, "t1", "bash", "lots\nof\noutput"),
	result(4, "t2", "read", "file text"),
	result(5, "t3", "edit", "edit failed: no match", true),
];

function transcript(expanded: boolean, settings: TuiSettings = {}): TranscriptView {
	const view = new TranscriptView(
		{
			theme: new ThemeRef(createTheme(BUILTIN_THEMES.dark!, "truecolor")),
			keyText: () => "ctrl+o",
			requestRender: () => {},
			cwd: "/work",
			markdownTransformers: [],
			toolRenderers: (name) =>
				resolveToolRenderers(name, new Map([["10:quiet-tools", quietTools]]), PLUGIN_TUI_RENDERERS, settings),
			entryRenderers: new Map(),
		},
		{ expanded, showThinking: false },
	);
	view.sync(
		buildTranscript(
			wholeView({
				conversation: { id: ROOT_CONVERSATION_ID } as Parameters<typeof wholeView>[0]["conversation"],
				entries,
				docs: {},
			}),
		),
	);
	return view;
}

test("collapsed: one line per call; a failed call keeps its full content", () => {
	const shown = plain(transcript(false).render(80));
	assert.match(shown, /Checking\.\n\n › bash npm run check … ✓ 2\.5s\n\n › read src\/a\.ts:10 ✓\n\n/);
	assert.doesNotMatch(shown, /lots|file text/);
	assert.match(shown, /edit src\/b\.ts[\s\S]*edit failed: no match/);
});

test("expanded: every call shows its full content", () => {
	const shown = plain(transcript(true).render(80));
	assert.doesNotMatch(shown, /›/);
	assert.match(shown, / \$ npm run check[\s\S]*lots\n of\n output/);
	assert.match(shown, /read src\/a\.ts[\s\S]*file text/);
});

test("setting full: the tools' own cards, boxed", () => {
	const shown = plain(transcript(false, { plugins: { "quiet-tools": { toolCalls: "full" } } }).render(80));
	assert.doesNotMatch(shown, /›/);
	assert.match(shown, /\$ npm run check/);
});

test("plugin settings: merged per setting, bounded, accepted by the launcher's patch check", () => {
	assert.deepEqual(
		mergeSettings({ plugins: { a: { x: 1, y: true } } }, { plugins: { a: { y: false }, b: { z: "s" } } }).plugins,
		{ a: { x: 1, y: false }, b: { z: "s" } },
	);
	assert.deepEqual(sanitizeSettings({ plugins: { a: { x: { nested: 1 } } } }).invalid, ["plugins"]);
	const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, true]));
	assert.deepEqual(sanitizeSettings({ plugins: { a: many } }).invalid, ["plugins"]);
	assert.ok("patch" in validatePrefsPatch({ settings: { plugins: { "quiet-tools": { toolCalls: "full" } } } }));
	assert.ok("patch" in validatePrefsPatch({ settings: { plugins: { "quiet-tools": { toolCalls: null } } } }));
	assert.ok("error" in validatePrefsPatch({ settings: { plugins: { "quiet-tools": { toolCalls: [1] } } } }));
});
