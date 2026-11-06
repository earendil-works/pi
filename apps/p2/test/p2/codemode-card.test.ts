// Code mode's calls (copied from Pi Mobile): nested calls live from pi.live.nestedTools, grouped by the model's call
// with depth from the parentCallId chain, settled from the result's details.calls; in the browser (the script's step
// in its turn's activity sheet) and in the TUI's card.
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
	"browser: the script's step, its highlighted script and its calls, live and settled",
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
			const call = (index: number) => `document.querySelectorAll('[data-testid=call]')[${index}]`;
			await show(running());
			// The activity row while it runs: the script, with the calls it has made so far.
			await browser.wait(
				"document.querySelector('[data-testid=activity][data-state=working]')?.textContent.includes('Running a script · 10 calls')",
			);
			await browser.click("[data-testid=activity]");
			await browser.wait("document.querySelector('[data-testid=step] button')");
			assert.match(
				await browser.evaluate<string>("document.querySelector('[data-testid=step]').textContent"),
				/^codemoderead every file● running/,
			);
			await browser.click("[data-testid=step] button");
			// The newest eight calls, the rest behind "Show all", as the transcript's card had them.
			await browser.wait("document.querySelectorAll('[data-testid=call]').length===8");
			assert.equal(
				await browser.evaluate("document.querySelector('[data-testid=calls-more]').textContent"),
				"Show all 10 tool calls · 1 failed",
			);
			assert.match(await browser.evaluate<string>(`${call(7)}.textContent`), /Running npm test|npm test/);
			await browser.click("[data-testid=calls-more]");
			await browser.wait("document.querySelectorAll('[data-testid=call]').length===10");
			assert.equal(
				await browser.evaluate("document.querySelector('.sheet-head h2').textContent"),
				"Ran a script · 10 calls, 1 failed",
			);
			// The script: highlighted JS, whole (8 lines need no Show all).
			assert.equal(
				await browser.evaluate("document.querySelector('[data-testid=detail-input] .hljs-keyword')!==null"),
				true,
			);
			assert.match(
				await browser.evaluate<string>("document.querySelector('[data-testid=detail-input]').textContent"),
				/return files\.length;/,
			);
			// The subagent's own read is marked as nested; the failed read shows its error, the running bash its last line.
			assert.match(await browser.evaluate<string>(`${call(1)}.textContent`), /Read inner\.ts · nested/);
			assert.equal(await browser.evaluate(`${call(3)}.dataset.state`), "error");
			assert.match(await browser.evaluate<string>(`${call(3)}.textContent`), /ENOENT: f3\.ts/);
			assert.equal(await browser.evaluate(`${call(9)}.dataset.state`), "running");
			assert.match(
				await browser.evaluate<string>(`${call(9)}.textContent`),
				/Running npm test.*running tests|npm test.*running tests/,
			);
			// Settled: the result's calls; a cancelled one is interrupted, a failure.
			await show(settled());
			await browser.wait("document.querySelectorAll('[data-testid=call]').length===3");
			assert.equal(
				await browser.evaluate(
					"[...document.querySelectorAll('[data-testid=call]')].map((row)=>row.dataset.state).join()",
				),
				"done,error,error",
			);
			assert.match(await browser.evaluate<string>(`${call(1)}.textContent`), /ENOENT: b\.ts/);
		} finally {
			await browser?.close();
			await fixture.close();
		}
	},
);
