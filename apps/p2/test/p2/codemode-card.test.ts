// Code mode's card (copied from Pi Mobile): nested calls live from pi.live.nestedTools, grouped by the model's call
// with depth from the parentCallId chain, settled from the result's details.calls; in the browser and the TUI.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryId, LiveState } from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { transcriptComponent } from "../../src/tui/messages.ts";
import { buildTranscript, type ToolView } from "../../src/web/transcript.ts";
import { wholeView } from "../fixtures/whole-view.ts";
import { Browser, browserTests } from "./browser.ts";
import { startFixture } from "./helpers.ts";

const CALL = "call-1";
const SCRIPT = [
	"// read every file",
	'const files = ["a.ts", "b.ts"];',
	"for (const path of files) {",
	"  await tools.read({ path });",
	"}",
	'await tools.bash({ command: "npm test" });',
	"text('done');",
	"return files.length;",
].join("\n");
const conversation = { id: 1 } as ConversationView["conversation"];

function assistant(id: number, callId: string, code = SCRIPT): ConversationView["entries"][number] {
	const message: AssistantMessage = {
		...fauxAssistantMessage([]),
		content: [{ type: "toolCall", id: callId, name: "codemode", arguments: { code } }],
		stopReason: "toolUse",
		timestamp: id,
	};
	return { id: id as EntryId, conversationId: conversation.id, kind: "pi.assistant", model: [message] };
}

type NestedSlot = NonNullable<LiveState["nestedTools"]>[number];
const slot = (
	parentCallId: string,
	key: string,
	taskId: number,
	name: string,
	args: Record<string, unknown>,
	status: NestedSlot["status"],
	extra: Partial<NestedSlot> = {},
): NestedSlot =>
	({
		callId: `${parentCallId}/${key}`,
		parentCallId,
		parentTaskId: 1,
		taskId,
		name,
		arguments: args,
		status,
		...extra,
	}) as NestedSlot;

/** The codemode call running: 9 calls of its script, the first with a call of its own, plus another call's slot. */
function running(): ConversationView {
	const nestedTools: NestedSlot[] = [
		slot(CALL, "c1", 10, "subagent", { name: "helper" }, "done", { summary: { isError: false, durationMs: 1500 } }),
		slot(`${CALL}/c1`, "1", 11, "read", { path: "/work/inner.ts" }, "done", { summary: { isError: false } }),
		slot("other-call", "c1", 12, "read", { path: "elsewhere" }, "running"),
	];
	for (let index = 2; index <= 9; index++)
		nestedTools.push(
			slot(
				CALL,
				`c${index}`,
				11 + index,
				index === 9 ? "bash" : "read",
				index === 9 ? { command: "npm test" } : { path: `f${index}.ts` },
				index === 9 ? "running" : "done",
				index === 9
					? { output: "building\nrunning tests\n" }
					: {
							summary: {
								isError: index === 3,
								durationMs: 40,
								...(index === 3 ? { error: "ENOENT: f3.ts" } : {}),
							},
						},
			),
		);
	return {
		conversation,
		entries: [assistant(2, CALL)],
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
			{ id: 1, name: "read", args: '{"path":"a.ts"}', status: "ok", durationMs: 12 },
			{ id: 2, name: "read", args: '{"path":"b.ts"}', status: "error", durationMs: 3, error: "ENOENT: b.ts" },
			{ id: 3, name: "bash", args: '{"command":"npm te...', status: "cancelled" },
		],
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: CALL,
		toolName: "codemode",
		content: [{ type: "text", text: "done\n2" }],
		details,
		isError: false,
		timestamp: 3,
	};
	return {
		conversation,
		entries: [
			assistant(2, CALL),
			{ id: 3 as EntryId, conversationId: conversation.id, kind: "pi.tool-result", model: [result] },
		],
		docs: {},
	};
}

const codemode = (view: ConversationView): ToolView | undefined =>
	buildTranscript(wholeView(view))
		.items.flatMap((item) => (item.type === "assistant" ? item.tools : []))
		.find((tool) => tool.id === CALL);

test("live nested calls are grouped under the model's call, with depth from the parent chain", () => {
	const card = codemode(running());
	assert.equal(card?.status, "running");
	assert.deepEqual(
		card?.calls?.map((call) => [call.id, call.name, call.status, call.depth]),
		[
			[`${CALL}/c1`, "subagent", "done", 0],
			[`${CALL}/c1/1`, "read", "done", 1],
			[`${CALL}/c2`, "read", "done", 0],
			[`${CALL}/c3`, "read", "error", 0],
			...[4, 5, 6, 7, 8].map((index) => [`${CALL}/c${index}`, "read", "done", 0]),
			[`${CALL}/c9`, "bash", "running", 0],
		],
	);
	assert.equal(card?.calls?.[0]?.durationMs, 1500);
	assert.equal(card?.calls?.[3]?.error, "ENOENT: f3.ts");
	assert.equal(card?.calls?.at(-1)?.output, "building\nrunning tests\n");
	// Another call's slots are not this call's rows.
	assert.ok(!card?.calls?.some((call) => call.id.startsWith("other-call")));
});

test("live calls of code mode's internal tools show by their script name, as settled ones do", () => {
	const view = running();
	const live = view.docs["pi.live"] as unknown as LiveState;
	const classify = slot(CALL, "c10", 30, "pi.codemode.models.classify", { prompt: "x" }, "running");
	const card = codemode({
		...view,
		docs: { ...view.docs, "pi.live": { ...live, nestedTools: [...(live.nestedTools ?? []), classify] } },
	} as ConversationView);
	assert.equal(card?.calls?.at(-1)?.name, "models.classify");
});

test("settled calls come from the result's details.calls", () => {
	const card = codemode(settled());
	assert.equal(card?.status, "done");
	assert.deepEqual(card?.calls, [
		{ id: `${CALL}/c1`, name: "read", args: { path: "a.ts" }, status: "done", depth: 0, durationMs: 12 },
		{
			id: `${CALL}/c2`,
			name: "read",
			args: { path: "b.ts" },
			status: "error",
			depth: 0,
			durationMs: 3,
			error: "ENOENT: b.ts",
		},
		// Arguments cut too short to parse stay text; a cancelled call shows as interrupted.
		{ id: `${CALL}/c3`, name: "bash", args: '{"command":"npm te...', status: "interrupted", depth: 0 },
	]);
	// Malformed details list nothing rather than wrong rows.
	const broken = settled();
	const entry = broken.entries[1]!;
	(entry.model![0] as ToolResultMessage).details = { calls: [{ id: "x" }] };
	assert.equal(codemode(broken)?.calls, undefined);
});

test("TUI shows pi's code mode card: the script, the newest nested calls by depth, then the output", () => {
	const render = (view: ConversationView, expanded = false) =>
		transcriptComponent(buildTranscript(wholeView(view)), false, expanded)
			.render(120)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");
	const live = render(running());
	assert.match(live, /codemode\n +\/\/ read every file/);
	// pi's renderer: the newest eight rows with status, name, JSON arguments, duration; earlier ones behind a hint.
	assert.match(live, /2 earlier calls/);
	assert.doesNotMatch(live, /subagent/);
	assert.match(live, /✗ read .*f3\.ts.* 40ms\n +ENOENT: f3\.ts/);
	assert.match(live, /… bash .*npm test.*\n +running tests/);
	const all = render(running(), true);
	assert.match(all, /✓ subagent .* 1\.5s\n {3,}✓ read .*\/work\/inner\.ts/);
	assert.match(all, /return files\.length;/);
	const done = render(settled());
	assert.match(
		done,
		/✓ read \{"path":"a\.ts"\} 12ms\n +✗ read \{"path":"b\.ts"\} 3ms\n +ENOENT: b\.ts\n +⊘ bash \{"command":"npm te\.\.\./,
	);
	assert.match(done, /done\n +2/);
});

test(
	"browser card: live rows (newest eight, Show all), the clipped script, and the settled summary",
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
			await show(running());
			await browser.wait("document.querySelectorAll('.nested-call').length===8");
			assert.equal(await browser.evaluate("document.querySelector('.tool-name').textContent"), "Code");
			assert.equal(
				await browser.evaluate("document.querySelector('.tool-summary').textContent"),
				"// read every file",
			);
			assert.equal(
				await browser.evaluate("document.querySelector('.nested .tool-link').textContent"),
				"Show all 10 tool calls · 1 failed",
			);
			// The newest rows: the running bash call with its last output line, the failed read with its error.
			assert.equal(
				await browser.evaluate("document.querySelector('.nested-call.running .nested-name').textContent"),
				"bash",
			);
			assert.equal(await browser.evaluate("document.querySelector('.nested-call.running .spinner')!==null"), true);
			assert.equal(
				await browser.evaluate("document.querySelector('.nested-call.running .nested-detail').textContent"),
				"running tests",
			);
			assert.equal(
				await browser.evaluate("document.querySelector('.nested-call.error .nested-error').textContent"),
				"ENOENT: f3.ts",
			);
			await browser.click(".nested .tool-link");
			await browser.wait("document.querySelectorAll('.nested-call').length===10");
			// A call's own call is indented one level.
			assert.equal(
				await browser.evaluate("document.querySelectorAll('.nested-call')[1].style.getPropertyValue('--depth')"),
				"1",
			);
			assert.equal(
				await browser.evaluate(
					"parseFloat(getComputedStyle(document.querySelectorAll('.nested-call')[1]).paddingLeft) > parseFloat(getComputedStyle(document.querySelectorAll('.nested-call')[0]).paddingLeft)",
				),
				true,
			);
			// The script: highlighted JS in the card body, clipped to its first lines until Show all.
			await browser.click(".tool-head");
			await browser.wait("document.querySelector('.script.clip pre')");
			assert.equal(await browser.evaluate("document.querySelector('.script .hljs-keyword')!==null"), true);
			const clipped = await browser.evaluate<number>(
				"document.querySelector('.script pre').getBoundingClientRect().height",
			);
			assert.equal(await browser.evaluate("document.querySelector('.script-more').textContent"), "Show all 8 lines");
			await browser.click(".script-more");
			await browser.wait("document.querySelector('.script') && !document.querySelector('.script.clip')");
			assert.ok(
				(await browser.evaluate<number>("document.querySelector('.script pre').getBoundingClientRect().height")) >
					clipped,
			);
			// Settled (a fresh card; an open list stays open when its call settles): the rows collapse behind the count.
			await show({ conversation, entries: [], docs: {} });
			await browser.wait("!document.querySelector('.tool')");
			await show(settled());
			await browser.wait("document.querySelector('.nested .tool-link')?.textContent==='3 tool calls · 2 failed'");
			assert.equal(await browser.evaluate("document.querySelectorAll('.nested-call').length"), 0);
			await browser.click(".nested .tool-link");
			await browser.wait("document.querySelectorAll('.nested-call').length===3");
			assert.equal(
				await browser.evaluate("document.querySelectorAll('.nested-call.error, .nested-call.interrupted').length"),
				2,
			);
			assert.equal(
				await browser.evaluate(
					"[...document.querySelectorAll('.nested-time')].map((time)=>time.textContent).join(',')",
				),
				"12ms,3ms,interrupted",
			);
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
