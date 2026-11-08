// Selected-block activity: docked on the right without a tab, a sheet on phones, with inline step and nested-call
// expansion. The active transcript block keeps an abbreviated latest thought above its non-thinking step.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryId, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const panel = "document.querySelector('[data-testid=activity-sheet]')";
const mobileSheet = "document.querySelector('.sheet-layer .sheet[data-testid=activity-sheet]')";
const step = (id: string) => `[data-testid=activity-sheet] [data-step-id="${id}"]`;

describe("activity panel in the app", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, session: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		const settings = join(fixture.dataDir, "settings.json");
		const base = existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>) : {};
		writeFileSync(settings, JSON.stringify({ ...base, detail: 3 }));
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Activity" }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send({ text: "bash", requestId: "bash" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => !live(view)?.run && JSON.stringify(view).includes("Echo: bash"), 30_000);
		chat.release();
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("uses p2's phone sheet, expands a step in place, and Back closes the panel directly", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait("document.querySelector('[data-testid=activity]') && !document.querySelector('.offline')");
		await browser.click("[data-testid=activity]");
		await browser.wait(mobileSheet);
		assert.equal(await browser.evaluate(`${panel}.querySelector('.sheet-grip')!==null`), true);
		assert.match(await browser.evaluate<string>(`${panel}.querySelector('h2').textContent`), /^1 step · \d+s$/);
		const route = await browser.evaluate("JSON.stringify(history.state.route)");
		await browser.click("[data-testid=step] > button");
		await browser.wait("document.querySelector('[data-testid=detail-command]')");
		assert.equal(
			await browser.evaluate("document.querySelector('[data-testid=step] > button').getAttribute('aria-expanded')"),
			"true",
		);
		assert.equal(await browser.evaluate("document.querySelector('[aria-label=Back]')"), null);
		assert.equal(await browser.evaluate("JSON.stringify(history.state.route)"), route);
		await browser.evaluate("history.back()");
		await browser.wait(`!${panel}`);
		assert.equal(await browser.evaluate("location.pathname"), `/s/${session}`);
		await browser.click("[data-testid=activity]");
		await browser.wait(panel);
		await browser.click(".sheet-head button[aria-label=Close]");
		await browser.wait(`!${panel} && !history.state.route.activity`);
	});

	it("docks on wide screens without a tab or scrim, and shares the right-hand area with the workspace", async () => {
		await browser.metrics(1440, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait("document.querySelector('[data-testid=activity]') && !document.querySelector('.offline')");
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelector('#activity-dock .activity-panel')");
		const box = await browser.evaluate<{ right: number; left: number; chatRight: number }>(`(() => {
			const r=${panel}.getBoundingClientRect(), main=document.querySelector('.main').getBoundingClientRect();
			return {right:r.right,left:r.left,chatRight:main.right};
		})()`);
		assert.equal(box.right, 1440);
		assert.equal(box.chatRight, box.left);
		assert.equal(await browser.evaluate("document.querySelector('.sheet-layer')"), null);
		assert.equal(await browser.evaluate(`${panel}.querySelector('[role=tablist]')`), null);
		await browser.click("[data-testid=step] > button");
		await browser.wait("document.querySelector('[data-testid=detail-command]')");
		// Opening the workspace replaces the activity view; Back restores its selected block and expansion.
		await browser.click('button[aria-label="Workspace files and changes"]');
		await browser.wait(`document.querySelector('.workspace') && !${panel}`);
		await browser.evaluate("history.back()");
		await browser.wait("document.querySelector('#activity-dock [data-testid=detail-command]')");
		await browser.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
		await browser.wait(`!${panel} && !history.state.route.activity`);
	});
});

const conversation = { id: 1 } as ConversationView["conversation"];

function respond(
	entries: ConversationView["entries"][number][],
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
	results: Record<string, Partial<ToolResultMessage>> = {},
): void {
	const timestamp = entries.length + 1;
	const message: AssistantMessage = { ...fauxAssistantMessage([]), content, stopReason, timestamp };
	entries.push({
		id: (entries.length + 1) as EntryId,
		conversationId: conversation.id,
		kind: "pi.assistant",
		model: [message],
	});
	for (const part of content) {
		if (part.type !== "toolCall") continue;
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: part.id,
			toolName: part.name,
			content: [{ type: "text", text: `ok ${part.id}` }],
			isError: false,
			timestamp,
			...results[part.id],
		};
		entries.push({
			id: (entries.length + 1) as EntryId,
			conversationId: conversation.id,
			kind: "pi.tool-result",
			model: [result],
		});
	}
}

const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});

function mixedTurn(): ConversationView {
	const entries: ConversationView["entries"][number][] = [];
	respond(entries, [
		{ type: "thinking", thinking: "Plan the fix." },
		{ type: "text", text: "First the tests." },
		call("t1", "bash", { command: "npm test" }),
		call("t2", "read", { path: "src/a.ts" }),
	]);
	respond(entries, [{ type: "text", text: "Now the fix." }, call("t3", "edit", { path: "src/a.ts" })]);
	respond(entries, [{ type: "text", text: "Fixed and tested." }], "stop");
	return { conversation, entries, docs: {} };
}

function longTurn(count: number): ConversationView {
	const entries: ConversationView["entries"][number][] = [];
	for (let index = 0; index < count; index++)
		respond(entries, [call(`call-${index}`, "bash", { command: `check ${index}` })]);
	return { conversation, entries, docs: {} };
}

const thought = "The build passed, but the deployment is still running. ".repeat(20);
function running(output: string, thinking = false): ConversationView {
	const content: AssistantMessage["content"] = [{ type: "thinking", thinking: thought }];
	if (!thinking) content.push(call("live", "bash", { command: "gh run watch 42468752859" }));
	const message = { ...fauxAssistantMessage([]), content, stopReason: "toolUse" as const, timestamp: 1 };
	return {
		conversation,
		entries: [{ id: 1 as EntryId, conversationId: conversation.id, kind: "pi.assistant", model: [message] }],
		docs: {
			"pi.live": {
				run: { taskId: 1, inputs: [] },
				tools: thinking ? [] : [{ callId: "live", name: "bash", taskId: 1, status: "running", output }],
			} as unknown as LiveState,
		} as ConversationView["docs"],
	};
}

describe("a block's steps and active thought", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	const show = async (view: ConversationView, detail: 1 | 2 | 3 | 4 = 3, width = 1440) => {
		await browser.metrics(width, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}`);
		await browser.wait("document.querySelector('.app')");
		await browser.loadFixture("codemode-card.ts");
		await browser.wait("typeof window.showCodemode==='function'");
		await browser.evaluate(`window.showCodemode(${JSON.stringify(view)}, ${detail})`);
		await browser.wait("document.querySelector('[data-testid=activity]')");
	};

	it("switches only through transcript blocks, remembering independent expansions without stacking panels", async () => {
		await show(mixedTurn());
		await browser.wait("document.querySelectorAll('.row [data-testid=activity]').length===2");
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('.row')].map(r=>r.querySelector('[data-testid=activity]')?'activity':r.querySelector('[data-testid=thought]')?'thought':r.textContent.trim())",
			),
			["thought", "First the tests.", "activity", "Now the fix.", "activity", "Fixed and tested."],
		);
		await browser.click("[data-testid=thought] button");
		await browser.wait("document.querySelector('.thinking-body')?.textContent==='Plan the fix.'");
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===2");
		await browser.click(`${step("t1")} > button`);
		await browser.click(`${step("t2")} > button`);
		assert.equal(
			await browser.evaluate("document.querySelectorAll('[data-testid=step] > button[aria-expanded=true]').length"),
			2,
		);
		const index = await browser.evaluate("history.state.index");
		await browser.evaluate("document.querySelectorAll('.row [data-testid=activity]')[1].click()");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===1");
		assert.equal(await browser.evaluate("document.querySelector('.step-name').textContent"), "edit");
		assert.equal(await browser.evaluate("history.state.index"), index);
		assert.equal(await browser.evaluate("document.querySelectorAll('.activity-block.selected').length"), 1);
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=step] > button[aria-expanded=true]').length===2");
		await browser.evaluate("history.back()");
		await browser.wait(`!${panel}`);
	});

	it("keeps generic and plugin details inline, with whole output, failures, numbered reads and diffs", async () => {
		const entries: ConversationView["entries"][number][] = [];
		const output = Array.from({ length: 60 }, (_, line) => `line ${line + 1}`).join("\n");
		respond(
			entries,
			[
				call("b", "bash", { command: "npm test" }),
				call("r", "read", { path: "src/a.ts", offset: 40, limit: 2 }),
				call("e", "edit", { path: "src/a.ts", edits: [] }),
				call("g", "web_fetch", { url: "https://example.com" }),
			],
			"toolUse",
			{
				b: { content: [{ type: "text", text: `${output}\nCommand exited with code 1` }], isError: true },
				r: { content: [{ type: "text", text: "40\tconst a = 1;\n41\tconst b = 2;" }] },
				e: {
					content: [{ type: "text", text: "Edited src/a.ts" }],
					details: { diff: "-40 const a = 1;\n+40 const a = 3;" },
				},
			},
		);
		respond(entries, [{ type: "text", text: "Done." }], "stop");
		await show({ conversation, entries, docs: {} });
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===4");
		assert.equal(
			await browser.evaluate(`document.querySelector('${step("b")} .step-state').textContent`),
			"✗ exit 1",
		);
		for (const id of ["b", "r", "e", "g"])
			await browser.evaluate(`document.querySelector('${step(id)} > button').click()`);
		await browser.wait("document.querySelectorAll('[data-testid=step] > .activity-detail').length===4");
		assert.equal(
			await browser.evaluate(`document.querySelector('${step("b")} [data-testid=detail-command]').textContent`),
			"$ npm test",
		);
		assert.equal(
			await browser.evaluate(`document.querySelector('${step("b")} pre.detail-output').textContent`),
			`${output}\nCommand exited with code 1`,
		);
		assert.equal(await browser.evaluate(`document.querySelector('${step("b")} [data-failed=true]')!==null`), true);
		assert.equal(await browser.evaluate(`document.querySelector('${step("b")} .detail-more')`), null);
		assert.equal(
			await browser.evaluate(`document.querySelector('${step("r")} .detail-path').textContent`),
			"src/a.ts · lines 40–41",
		);
		assert.deepEqual(
			await browser.evaluate(
				`[...document.querySelectorAll('${step("r")} .diff-line')].map(e=>e.querySelector('.diff-number').textContent+':'+e.querySelector('.diff-code').textContent)`,
			),
			["40:const a = 1;", "41:const b = 2;"],
		);
		assert.deepEqual(
			await browser.evaluate(
				`[...document.querySelectorAll('${step("e")} pre.diff .diff-line')].map(e=>e.className.replace('diff-line','').trim()+':'+e.textContent.trim())`,
			),
			["del:-40 const a = 1;", "add:+40 const a = 3;"],
		);
		assert.match(
			await browser.evaluate<string>(
				`document.querySelector('${step("g")} [data-testid=detail-input]').textContent`,
			),
			/"url": "https:\/\/example.com"/,
		);
		assert.equal(
			await browser.evaluate(`document.querySelector('${step("g")} pre.detail-output').textContent`),
			"ok g",
		);
	});

	it("shows the latest thought above the current step, clamps it, and streams output without closing expanded details", async () => {
		await show(running("building\n"), 2);
		await browser.wait("document.querySelector('[data-testid=activity-thought]')");
		assert.equal(
			await browser.evaluate("document.querySelector('[data-testid=activity-thought]').textContent"),
			thought,
		);
		const clamp = await browser.evaluate<{ lines: string; clipped: boolean }>(
			"(e=>({lines:getComputedStyle(e).webkitLineClamp,clipped:e.scrollHeight>e.clientHeight}))(document.querySelector('.activity-thought-text'))",
		);
		assert.deepEqual(clamp, { lines: "3", clipped: true });
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelector('pre.detail-output')?.textContent==='building'");
		await browser.evaluate(`window.showCodemode(${JSON.stringify(running("building\ntesting\n"))}, 2)`);
		await browser.wait("document.querySelector('pre.detail-output')?.textContent==='building\\ntesting'");
		assert.equal(
			await browser.evaluate(`document.querySelector('${step("live")} > button').getAttribute('aria-expanded')`),
			"true",
		);
		// Inspecting a thought does not hide the running tool, and reveals the full text.
		await browser.evaluate("document.querySelector('[data-kind=thought] > button').click()");
		await browser.wait("document.querySelector('.detail-prose')");
		assert.equal(
			await browser.evaluate("document.querySelector('.detail-prose').textContent.trim()"),
			thought.trim(),
		);
	});

	it("does not duplicate the currently thinking step, and removes the preview once the block finishes", async () => {
		await show(running("", true), 2);
		assert.equal(await browser.evaluate("document.querySelector('[data-testid=activity-thought]')"), null);
		await browser.evaluate(`window.showCodemode(${JSON.stringify(running("done"))}, 2)`);
		await browser.wait("document.querySelector('[data-testid=activity-thought]')");
		const entries: ConversationView["entries"][number][] = [];
		respond(entries, [
			{ type: "thinking", thinking: thought },
			call("live", "bash", { command: "gh run watch 42468752859" }),
		]);
		respond(entries, [{ type: "text", text: "The deployment passed." }], "stop");
		await browser.evaluate(`window.showCodemode(${JSON.stringify({ conversation, entries, docs: {} })}, 2)`);
		await browser.wait("document.querySelector('[data-testid=activity][data-state=done]')");
		assert.equal(await browser.evaluate("document.querySelector('[data-testid=activity-thought]')"), null);
	});

	it("keeps selection and expansion when resizing between the right panel and phone sheet", async () => {
		await show(mixedTurn());
		await browser.click("[data-testid=activity]");
		await browser.wait(panel);
		await browser.click(`${step("t1")} > button`);
		await browser.metrics(390, 844);
		await browser.wait(`${mobileSheet}?.querySelector('[data-testid=detail-command]')`);
		await browser.metrics(1440, 900);
		await browser.wait("document.querySelector('#activity-dock [data-testid=detail-command]')");
		assert.equal(await browser.evaluate("document.querySelector('.sheet-layer')"), null);
	});

	it("opens long runs at the newest calls, but leaves a reader inspecting earlier steps in place", async () => {
		await show(longTurn(30));
		await browser.click("[data-testid=activity]");
		const body = `${panel}.querySelector('.activity-panel-body')`;
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===30");
		await browser.wait(`(p=>p.scrollHeight-p.clientHeight-p.scrollTop<2)(${body})`);
		await browser.evaluate(`${body}.scrollTop=0; ${body}.dispatchEvent(new Event('scroll'))`);
		await browser.wait(`${body}.scrollTop===0`);
		await browser.evaluate(`window.showCodemode(${JSON.stringify(longTurn(31))}, 3)`);
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===31");
		assert.equal(await browser.evaluate(`${body}.scrollTop`), 0);
	});
});
