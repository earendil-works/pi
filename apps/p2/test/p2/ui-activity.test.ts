// Selected-block activity: docked on the right without a tab, a sheet on phones, with inline step and nested-call
// expansion. The active transcript block shows its latest thought below the wheel (ThoughtSlot).
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
		await browser.signIn(fixture.owner);
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
		await browser.wait("document.querySelector('#side-dock .activity-panel')");
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
		await browser.wait("document.querySelector('#side-dock [data-testid=detail-command]')");
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
		await browser.signIn(fixture.owner);
		// Every page starts without remembered panels (src/web/session-panels.ts): each view below shows in the Familiar's
		// session, which would otherwise reopen the block an earlier test left open there.
		await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `localStorage.removeItem("p2-session-panels")`,
		});
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	const show = async (view: ConversationView, detail: 1 | 2 | 3 | 4 = 3, width = 1440) => {
		await browser.metrics(width, 900);
		// A new history entry: opening the same URL again keeps its route, and with it a panel an earlier test left open,
		// which the test's first tap on the same block would close.
		await browser.open("about:blank");
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
				"[...document.querySelectorAll('.row')].map(r=>r.querySelector('[data-testid=activity]')?'activity':r.querySelector('[data-testid=thought]')?'thought':r.textContent.replace(r.querySelector('.message-time')?.textContent??'','').trim())",
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

	it("closes the panel when the same block is tapped again, but not when another block is", async () => {
		await show(mixedTurn());
		await browser.wait("document.querySelectorAll('.row [data-testid=activity]').length===2");
		await browser.click("[data-testid=activity]");
		await browser.wait(`${panel} && document.querySelectorAll('[data-testid=step]').length===2`);
		await browser.evaluate("document.querySelectorAll('.row [data-testid=activity]')[1].click()");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===1");
		await browser.evaluate("document.querySelectorAll('.row [data-testid=activity]')[1].click()");
		await browser.wait(`!${panel} && !history.state.route.activity`);
		assert.equal(await browser.evaluate("document.querySelectorAll('.activity-block.selected').length"), 0);
	});

	it("shows when steps started, once per minute", async () => {
		const minute = new Date().setHours(9, 5, 0, 0);
		const entries: ConversationView["entries"][number][] = [];
		respond(
			entries,
			[
				call("a", "bash", { command: "one" }),
				call("b", "bash", { command: "two" }),
				call("c", "bash", { command: "three" }),
			],
			"toolUse",
			{
				// Started 09:05:03, 09:05:20 and 09:06:10: the second shares the first's minute.
				a: { timestamp: minute + 5_000, durationMs: 2_000 },
				b: { timestamp: minute + 20_000 },
				c: { timestamp: minute + 70_000 },
			},
		);
		await show({ conversation, entries, docs: {} });
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===3");
		// In the browser's locale.
		const clock = (at: number) =>
			browser.evaluate<string>(`new Date(${at}).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })`);
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=step]')].map((e) => e.querySelector('.step-time')?.textContent ?? '')",
			),
			[await clock(minute + 3_000), "", await clock(minute + 70_000)],
		);
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

	it("shows a step's images as thumbnails in its collapsed row: the last four (two on phones), +N, outside its name", async () => {
		const svg = (fill: string) =>
			Buffer.from(
				`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${fill}"/></svg>`,
			).toString("base64");
		const image = (fill: string) => ({ type: "image" as const, data: svg(fill), mimeType: "image/svg+xml" });
		const fills = ["red", "orange", "gold", "green", "blue", "purple"];
		const entries: ConversationView["entries"][number][] = [];
		respond(
			entries,
			[
				call("shot", "read", { path: "shot.png" }),
				call("text", "read", { path: "src/a.ts" }),
				call("script", "codemode", { code: "// Screenshots of each page\nimage(shot);" }),
			],
			"toolUse",
			{
				shot: { content: [{ type: "text", text: "Read image file [image/svg+xml]." }, image("teal")] },
				text: { content: [{ type: "text", text: "1\tconst a = 1;" }] },
				script: { content: [{ type: "text", text: "done" }, ...fills.map(image)] },
			},
		);
		respond(entries, [{ type: "text", text: "Done." }], "stop");
		const view = { conversation, entries, docs: {} };
		await show(view);
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===3");
		// What a row shows: its visible thumbnails and count.
		const thumbs = (id: string) =>
			browser.evaluate<{
				more: string | null;
				fills: string[];
				sizes: string[];
				hidden: string | null;
				alts: string[];
			}>(
				`(t=>{if(!t)return null;const shown=[...t.querySelectorAll('img')].filter(i=>i.checkVisibility());
					return {more:[...t.querySelectorAll('.step-thumbs-more')].find(e=>e.checkVisibility())?.textContent??null,
					fills:shown.map(i=>/fill="(\\w+)"/.exec(atob(i.src.split(',')[1]))[1]),
					sizes:shown.map(i=>i.getBoundingClientRect().width+'x'+i.getBoundingClientRect().height),
					hidden:t.getAttribute('aria-hidden'),alts:shown.map(i=>i.alt)}})(document.querySelector('${step(id)} > button [data-testid=step-thumbs]'))`,
			);
		assert.deepEqual(await thumbs("shot"), {
			more: null,
			fills: ["teal"],
			sizes: ["44x34"],
			hidden: "true",
			alts: [""],
		});
		assert.equal(await thumbs("text"), null);
		assert.deepEqual(await thumbs("script"), {
			more: "+2",
			fills: ["gold", "green", "blue", "purple"],
			sizes: ["44x34", "44x34", "44x34", "44x34"],
			hidden: "true",
			alts: ["", "", "", ""],
		});
		// The thumbnails fit the row: a row with images is as tall as one without.
		const heights = await browser.evaluate<number[]>(
			`["shot","text","script"].map(id=>document.querySelector('[data-testid=activity-sheet] [data-step-id="'+id+'"] > button').getBoundingClientRect().height)`,
		);
		assert.equal(new Set(heights).size, 1);
		// A tap expands the row as before; its detail shows every image at full width, a script's too.
		await browser.click(`${step("script")} > button`);
		await browser.wait(`document.querySelectorAll('${step("script")} .activity-detail .detail-image').length===6`);
		await browser.click(`${step("shot")} > button`);
		await browser.wait(`document.querySelectorAll('${step("shot")} .activity-detail .detail-image').length===1`);
		await browser.evaluate("history.back()");
		await browser.wait(`!${panel}`);
		// At detail 4 the calls are rows in the transcript, with the same thumbnails.
		await show(view, 4);
		await browser.wait("document.querySelectorAll('.activity-rows [data-testid=step-thumbs]').length===2");
		assert.equal(
			await browser.evaluate(
				"[...document.querySelectorAll('.activity-rows [data-step-id=script] .step-thumbs-more')].find(e=>e.checkVisibility()).textContent",
			),
			"+2",
		);
		// Below 700px (the phone sheet) the last two, the rest counted.
		await show(view, 3, 390);
		await browser.click("[data-testid=activity]");
		await browser.wait(`${mobileSheet} && document.querySelectorAll('[data-testid=step]').length===3`);
		assert.deepEqual(await thumbs("script"), {
			more: "+4",
			fills: ["blue", "purple"],
			sizes: ["44x34", "44x34"],
			hidden: "true",
			alts: ["", ""],
		});
		assert.deepEqual(await thumbs("shot"), {
			more: null,
			fills: ["teal"],
			sizes: ["44x34"],
			hidden: "true",
			alts: [""],
		});
	});

	it("shows the latest thought below the wheel in three lines, and streams output without closing expanded details", async () => {
		await show(running("building\n"), 2);
		const words = "document.querySelector('[data-testid=activity-slot-words]')";
		await browser.wait(`${words}?.textContent===${JSON.stringify(thought.trim())}`);
		// Below the wheel: the slot follows the wheel's row in the block, its icon under the wheel's icon.
		assert.equal(
			await browser.evaluate("document.querySelector('.activity-block > .activity + .activity-slot') !== null"),
			true,
		);
		const layout = await browser.evaluate<{ lines: number; clipped: boolean; icon: number }>(
			`(() => {
				const window = document.querySelector('.activity-slot-window');
				const line = parseFloat(getComputedStyle(window).lineHeight) || parseFloat(getComputedStyle(window).fontSize) * 1.65;
				const icon = document.querySelector('.activity-slot-icon').getBoundingClientRect().left - document.querySelector('.activity .el-ticker-item[data-current] svg').getBoundingClientRect().left;
				return { lines: Math.round(window.clientHeight / line), clipped: window.classList.contains('more-above'), icon: Math.round(icon) };
			})()`,
		);
		assert.deepEqual(layout, { lines: 3, clipped: true, icon: 0 });
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

	it("shows the thought while it streams, and hands its place to the answer once the block finishes", async () => {
		const words = "document.querySelector('[data-testid=activity-slot-words]')";
		await show(running("", true), 2);
		await browser.wait(`${words}?.textContent===${JSON.stringify(thought.trim())}`);
		// Its height grows to fit (a transition).
		await browser.wait("document.querySelector('.activity-slot').getBoundingClientRect().height>40");
		await browser.evaluate(`window.showCodemode(${JSON.stringify(running("done"))}, 2)`);
		await browser.wait(
			"document.querySelector('[data-testid=activity] [data-current]')?.textContent.includes('gh run watch')",
		);
		assert.equal(await browser.evaluate(`${words}.textContent`), thought.trim());
		const entries: ConversationView["entries"][number][] = [];
		respond(entries, [
			{ type: "thinking", thinking: thought },
			call("live", "bash", { command: "gh run watch 42468752859" }),
		]);
		respond(entries, [{ type: "text", text: "The deployment passed." }], "stop");
		await browser.evaluate(`window.showCodemode(${JSON.stringify({ conversation, entries, docs: {} })}, 2)`);
		await browser.wait("document.querySelector('[data-testid=activity][data-state=done]')");
		// The slot left the layout; the answer took its place and, the turn over, gives back the space it does not need.
		assert.deepEqual(
			await browser.evaluate(
				"(() => { const slot = document.querySelector('.activity-slot'); const answer = document.querySelector('.activity-block').closest('.row').nextElementSibling; return { slot: slot.classList.contains('handed-off') && slot.getBoundingClientRect().height === 0, handoff: answer.dataset.handoff, minHeight: answer.style.minHeight }; })()",
			),
			{ slot: true, handoff: "released", minHeight: "0px" },
		);
	});

	it("starts a shorter next thought on the slot's first line, keeping the taller space, and scrolls a long one", async () => {
		const working = (entries: ConversationView["entries"][number][], callId: string): ConversationView => ({
			conversation,
			entries,
			docs: {
				"pi.live": {
					run: { taskId: 1, inputs: [] },
					tools: [{ callId, name: "bash", taskId: 1, status: "running", output: "" }],
				} as unknown as LiveState,
			} as ConversationView["docs"],
		});
		const first: ConversationView["entries"][number][] = [];
		respond(first, [
			// Models' summaries end in blank lines and separate their parts with them: neither takes a line of the slot.
			{
				type: "thinking",
				thinking: `**Checking the build**\n\n${"Check the build output before changing anything else. ".repeat(6)}\n\n`,
			},
			call("a", "bash", { command: "npm run build" }),
		]);
		await show(working(first, "a"), 2, 390);
		const words = "document.querySelector('[data-testid=activity-slot-words]')";
		await browser.wait(`${words}?.textContent.startsWith('Checking the build\\nCheck the build')`);
		// Longer than three lines: it scrolls, its newest line in view and the edge above faded.
		await browser.wait(
			"(w => w.scrollHeight > w.clientHeight && w.scrollTop >= w.scrollHeight - w.clientHeight - 2 && w.classList.contains('more-above'))(document.querySelector('.activity-slot-window'))",
		);
		// The reader scrolls up to read: the words stay there while the thought grows.
		const area = "document.querySelector('.activity-slot-window')";
		await browser.evaluate(
			`(w => { w.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 })); w.scrollTop = 0; })(${area})`,
		);
		const grown: ConversationView["entries"][number][] = [];
		respond(grown, [
			{
				type: "thinking",
				thinking: `**Checking the build**\n\n${"Check the build output before changing anything else. ".repeat(6)}More.`,
			},
			call("a", "bash", { command: "npm run build" }),
		]);
		await browser.evaluate(`window.showCodemode(${JSON.stringify(working(grown, "a"))}, 2)`);
		await browser.wait(`${words}?.textContent.endsWith('More.')`);
		await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 400))");
		assert.equal(await browser.evaluate(`${area}.scrollTop`), 0);
		const second = [...first];
		respond(second, [{ type: "thinking", thinking: "Short.\n\n" }, call("b", "bash", { command: "npm test" })]);
		await browser.evaluate(`window.showCodemode(${JSON.stringify(working(second, "b"))}, 2)`);
		await browser.wait(`${words}?.textContent==='Short.'`);
		await browser.evaluate("new Promise((resolve) => setTimeout(resolve, 600))");
		const place = await browser.evaluate<{ offset: number; lines: number }>(
			`(() => {
				const window = document.querySelector('.activity-slot-window');
				const line = parseFloat(getComputedStyle(window).lineHeight);
				return {
					offset: Math.round(${words}.getBoundingClientRect().top - window.getBoundingClientRect().top),
					lines: Math.round((document.querySelector('.activity-slot').getBoundingClientRect().height - 12) / line),
				};
			})()`,
		);
		assert.deepEqual(place, { offset: 0, lines: 3 });
	});

	it("keeps selection and expansion when resizing between the right panel and phone sheet", async () => {
		await show(mixedTurn());
		await browser.click("[data-testid=activity]");
		await browser.wait(panel);
		await browser.click(`${step("t1")} > button`);
		await browser.metrics(390, 844);
		await browser.wait(`${mobileSheet}?.querySelector('[data-testid=detail-command]')`);
		await browser.metrics(1440, 900);
		await browser.wait("document.querySelector('#side-dock [data-testid=detail-command]')");
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
