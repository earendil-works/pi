// Code mode card rows (owner decision 6, also in Pi Mobile): a call a restart cut short shows as interrupted, not as an
// error; and a list opened with "Show all" while the script ran collapses to its summary once the script settles.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryId, LiveState } from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import { buildTranscript } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { Browser, browserTests } from "./browser.ts";
import { startFixture } from "./helpers.ts";

const CALL = "call-1";
const INTERRUPTED = "Tool bash was interrupted and may have partially run";
const conversation = { id: 1 } as ConversationView["conversation"];
type NestedSlot = NonNullable<LiveState["nestedTools"]>[number];

const assistant: ConversationView["entries"][number] = {
	id: 2 as EntryId,
	conversationId: conversation.id,
	kind: "pi.assistant",
	model: [
		{
			...fauxAssistantMessage([]),
			content: [{ type: "toolCall", id: CALL, name: "codemode", arguments: { code: "await tools.bash({})" } }],
			stopReason: "toolUse",
			timestamp: 2,
		} satisfies AssistantMessage,
	],
};

/** The script running with `count` finished calls (the last one interrupted by a restart) and one running. */
function running(count: number): ConversationView {
	const nestedTools = Array.from(
		{ length: count + 1 },
		(_, index) =>
			({
				callId: `${CALL}/c${index + 1}`,
				parentCallId: CALL,
				parentTaskId: 1,
				taskId: 10 + index,
				name: "bash",
				arguments: { command: `step ${index + 1}` },
				status: index === count ? "running" : "done",
				...(index === count
					? {}
					: {
							summary:
								index === count - 1
									? { isError: true, error: INTERRUPTED }
									: index === 0
										? { isError: true, error: "exit code 1" }
										: { isError: false, durationMs: 5 },
						}),
			}) as unknown as NestedSlot,
	);
	return {
		conversation,
		entries: [assistant],
		docs: {
			"pi.live": {
				run: { taskId: 1, inputs: [] },
				tools: [{ callId: CALL, name: "codemode", taskId: 1, status: "running" }],
				nestedTools,
			} as unknown as LiveState,
		} as ConversationView["docs"],
	};
}

function settled(): ConversationView {
	const details: CodemodeToolDetails = {
		calls: [
			{ id: 1, name: "bash", args: '{"command":"one"}', status: "ok", durationMs: 4 },
			{ id: 2, name: "bash", args: '{"command":"two"}', status: "error", error: INTERRUPTED },
			{ id: 3, name: "bash", args: '{"command":"three"}', status: "error", error: "exit code 2" },
		],
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: CALL,
		toolName: "codemode",
		content: [{ type: "text", text: "two failed: interrupted" }],
		details,
		isError: false,
		timestamp: 3,
	};
	return {
		conversation,
		entries: [
			assistant,
			{ id: 3 as EntryId, conversationId: conversation.id, kind: "pi.tool-result", model: [result] },
		],
		docs: {},
	};
}

const calls = (view: ConversationView) =>
	buildTranscript(wholeView(view))
		.items.flatMap((item) => (item.type === "assistant" ? item.tools : []))
		.find((tool) => tool.name === "codemode")?.calls ?? [];

test("a call interrupted by a restart is interrupted, live and settled; other errors stay errors", () => {
	assert.deepEqual(
		calls(running(3)).map((call) => call.status),
		["error", "done", "interrupted", "running"],
	);
	assert.equal(calls(running(3))[2]?.error, INTERRUPTED);
	assert.deepEqual(
		calls(settled()).map((call) => call.status),
		["done", "interrupted", "error"],
	);
});

test(
	"browser: a list opened with Show all while the script runs collapses to its summary once it settles",
	{ skip: !browserTests, timeout: 60_000 },
	async () => {
		const fixture = await startFixture({ web: true });
		let browser: Browser | undefined;
		try {
			browser = await Browser.start();
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}`);
			await browser.wait("document.querySelector('.app')");
			await browser.loadFixture("codemode-card.ts");
			await browser.wait("typeof window.showCodemode==='function'");
			const show = (view: ConversationView) => browser!.evaluate(`window.showCodemode(${JSON.stringify(view)})`);
			await show(running(9));
			await browser.wait("document.querySelectorAll('.nested-call').length===8");
			await browser.click(".nested .tool-link");
			await browser.wait("document.querySelectorAll('.nested-call').length===10");
			assert.equal(await browser.evaluate("document.querySelectorAll('.nested-call.interrupted').length"), 1);
			assert.equal(
				await browser.evaluate("document.querySelector('.nested-call.interrupted .nested-name').textContent"),
				"bash",
			);
			// The same card settles: the opened list collapses to the count; it opens again on request.
			await show(settled());
			await browser.wait("document.querySelector('.nested .tool-link')?.textContent==='3 tool calls · 2 failed'");
			assert.equal(await browser.evaluate("document.querySelectorAll('.nested-call').length"), 0);
			await browser.click(".nested .tool-link");
			await browser.wait("document.querySelectorAll('.nested-call').length===3");
			assert.equal(
				await browser.evaluate("[...document.querySelectorAll('.nested-call')].map((row)=>row.className).join()"),
				"nested-call done,nested-call interrupted,nested-call error",
			);
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
