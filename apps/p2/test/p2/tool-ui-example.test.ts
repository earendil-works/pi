// The example of docs/tool-ui.md (a `word_count` tool, test/fixtures/plugins/word-count): the document shows the
// fixture's files as they are, the tool works, and its contributions draw it in the chat (the wheel's summary, the step
// list, the detail) and in the TUI's card.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { transcriptComponent } from "../../src/tui/messages.ts";
import { buildTranscript } from "../../src/web/transcript.ts";
import { type WordCountDetails, wordCountExtension } from "../fixtures/plugins/word-count/tool.ts";
import { wordCountRenderers } from "../fixtures/plugins/word-count/tui.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { Browser, browserTests } from "./browser.ts";
import { startFixture } from "./helpers.ts";

const EXAMPLE = new URL("../fixtures/plugins/word-count/", import.meta.url);
const TEXT = "The quick brown fox\njumps over the lazy dog";

test("docs/tool-ui.md shows the example plugin's files as they are", () => {
	const doc = readFileSync(new URL("../../docs/tool-ui.md", import.meta.url), "utf8");
	const shown = new Map(
		[...doc.matchAll(/^```\w+ plugins\/word-count\/(\S+)\n([\s\S]*?)^```$/gm)].map(([, file, code]) => [file, code]),
	);
	const files = readdirSync(EXAMPLE).sort();
	assert.deepEqual([...shown.keys()].sort(), files);
	for (const file of files) assert.equal(shown.get(file), readFileSync(new URL(file, EXAMPLE), "utf8"), file);
});

/** A call of the example tool: its result as Durable records it, from the tool's own `execute`. */
async function result(id: string, text: string): Promise<ToolResultMessage> {
	const tool = wordCountExtension.tools?.[0];
	assert.ok(tool);
	const api = {} as ToolExecutionApi<WordCountDetails>;
	try {
		const done = await tool.execute({ text }, api, BACKGROUND_CONTEXT);
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: "word_count",
			content: (done.output ?? []).filter((part) => part.type === "text"),
			...(done.details === undefined ? {} : { details: done.details }),
			isError: false,
			timestamp: 3,
		};
	} catch (error) {
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: "word_count",
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			isError: true,
			timestamp: 3,
		};
	}
}

/** A turn: two calls of the tool (the second with an empty text, which fails), then the answer. */
async function view(): Promise<ConversationView> {
	const conversation = { id: 1 } as ConversationView["conversation"];
	const entry = (id: number, kind: string, message: AssistantMessage | ToolResultMessage) =>
		({
			id: id as EntryId,
			conversationId: conversation.id,
			kind,
			model: [message],
		}) as ConversationView["entries"][number];
	const calls: AssistantMessage = {
		...fauxAssistantMessage([]),
		content: [
			{ type: "toolCall", id: "w1", name: "word_count", arguments: { text: TEXT } },
			{ type: "toolCall", id: "w2", name: "word_count", arguments: { text: " " } },
		],
		stopReason: "toolUse",
		timestamp: 2,
	};
	const answer: AssistantMessage = {
		...fauxAssistantMessage([]),
		content: [{ type: "text", text: "Counted." }],
		timestamp: 5,
	};
	return {
		conversation,
		entries: [
			entry(2, "pi.assistant", calls),
			entry(3, "pi.tool-result", await result("w1", TEXT)),
			entry(4, "pi.tool-result", await result("w2", " ")),
			entry(5, "pi.assistant", answer),
		],
		docs: {},
	};
}

test("the tool counts; an empty text fails", async () => {
	const done = await result("w1", TEXT);
	assert.deepEqual(done.details, { words: 9, lines: 2 });
	assert.equal(done.isError, false);
	assert.equal((await result("w2", " ")).isError, true);
});

test("TUI: the tool's card shows its text, then its counts", async () => {
	const lines = transcriptComponent(buildTranscript(wholeView(await view())), false, false, {
		renderers: new Map([["word_count", wordCountRenderers]]),
	})
		.render(100)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.join("\n");
	assert.match(lines, /word_count The quick brown fox/);
	assert.match(lines, /9 words, 2 lines/);
	assert.match(lines, /Nothing to count: the text is empty\./);
});

test(
	"browser: the wheel's summary, the step list and the detail come from the tool's contribution",
	{ skip: !browserTests, timeout: 60_000 },
	async () => {
		const fixture = await startFixture({ web: true });
		let browser: Browser | undefined;
		try {
			browser = await Browser.start();
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.querySelector('.app')");
			await browser.loadFixture("word-count.ts");
			await browser.wait("typeof window.showWordCount==='function'");
			await browser.evaluate(`window.showWordCount(${JSON.stringify(await view())})`);
			// The wheel's summary: the tool's phrase, counted (a failed call is red on the wheel, not counted in words).
			await browser.wait(
				"document.querySelector('[data-testid=activity][data-state=done]')?.textContent.includes('Counted words in 2 texts · 2 steps')",
			);
			// The step list: the tool's name, its argument, ✓ or the tool's failure word.
			await browser.click("[data-testid=activity]");
			await browser.wait("document.querySelectorAll('[data-testid=step] button').length===2");
			const steps = await browser.evaluate<string[]>(
				"[...document.querySelectorAll('[data-testid=step]')].map((step)=>step.textContent)",
			);
			assert.match(steps[0] ?? "", /^word_countThe quick brown fox✓/);
			assert.match(steps[1] ?? "", /^word_count✗ empty text/);
			// The detail: the tool's own, under the tool's words.
			await browser.click("[data-testid=step] button");
			await browser.wait("document.querySelector('[data-testid=word-count]')");
			assert.equal(
				await browser.evaluate("document.querySelector('.sheet-head h2').textContent"),
				"Counted words in The quick brown fox",
			);
			assert.equal(
				await browser.evaluate("document.querySelector('[data-testid=word-count]').textContent"),
				"9 words, 2 lines",
			);
			assert.match(
				await browser.evaluate<string>("document.querySelector('[data-testid=detail-input]').textContent"),
				/jumps over the lazy dog/,
			);
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
