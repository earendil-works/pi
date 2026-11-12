// Views in Chromium: the agent's views show beside the transcript; an html artifact's page (a glyph editor, written
// against `window.p2view` as Max's is) gets its state, saves the person's changes (`setState` with a function) and
// selection (the composer's chip shows what the next message carries) and follows the agent's state; comments,
// removals and drawings mark up panes; a tab drags beside another area; phones show one pane at a time. Fake provider
// (`codemode <script>`), a disposable session.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ArtifactPage } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Views } from "../../plugins/views/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

/**
 * A small glyph editor: three points; clicking one selects it (`setState` with a function, and `select`), the agent's
 * state redraws it; `from` of the last state it got is in `window.lastFrom`.
 */
const EDITOR = `<!doctype html><html><head><style>body{margin:0;padding:12px;font-family:sans-serif}</style></head><body>
<p id=title></p><div id=points></div>
<script>
const P2 = window.p2view || null;
let state;
const draw = () => {
	document.getElementById('title').textContent = 'Glyph ' + state.glyph;
	document.getElementById('points').innerHTML = state.points.map((p, i) => '<button data-i="' + i + '">' + (state.selected === i ? '*' : '') + 'point ' + i + '</button>').join('');
};
P2.onState((value, from) => { window.lastFrom = from; state = value || { glyph: 'a', points: [[0, 0], [1, 1], [2, 0]] }; draw(); });
document.getElementById('points').addEventListener('click', (event) => {
	const i = Number(event.target.dataset.i);
	if (P2.readOnly) return;
	P2.setState((current) => ({ ...(current || state), selected: i }));
	state = { ...state, selected: i };
	P2.select('point ' + i + ' of glyph ' + state.glyph, { point: i });
	draw();
});
</script></body></html>`;

const tabCentre = (title: string) =>
	`(() => {const t=[...document.querySelectorAll('.views-tab')].find(e=>e.textContent===${JSON.stringify(title)});const r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`;

describe("views in Chromium", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	let views: RefIn<typeof Views, "editor">;
	let calls = 0;

	/** Runs `script` in code mode as the agent, and waits for its turn to end. */
	const script = async (code: string) => {
		calls++;
		await chat.send({ text: `codemode ${code}`, requestId: `script-${calls}` }, BACKGROUND_CONTEXT);
		const results = await until(chat.view, (value) => {
			const done = (value?.entries ?? []).flatMap((entry) =>
				(entry.model ?? []).filter(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolName === "codemode",
				),
			);
			return done.length === calls && !(value?.docs["pi.live"] as { run?: unknown })?.run;
		});
		const result = (results?.entries ?? [])
			.flatMap((entry) => entry.model ?? [])
			.filter((message): message is ToolResultMessage => message.role === "toolResult")
			.at(-1);
		assert.equal(result?.isError, false, JSON.stringify(result?.content));
		return result;
	};
	const mouse = (type: string, x: number, y: number) =>
		browser.call("Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button: "left",
			buttons: type === "mouseReleased" ? 0 : 1,
			clickCount: 1,
		});

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "notes.md"), "# Plan\n\nWe draw the **letter a** first.\n");
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace, title: "Views" }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		views = await holdIn(owner, Views, { session }, "editor");
		await script(`await tools.view_open({ kind: "markdown", title: "Plan", item: "notes.md", id: "plan" });`);
		await script(
			[
				`await tools.artifact_write({ id: "glyph", kind: "html", title: "Glyph editor", content: ${JSON.stringify(EDITOR)} });`,
				`await tools.view_open({ kind: "html", item: "glyph", title: "Glyph editor", id: "glyph" });`,
			].join("\n"),
		);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("shows the views beside the transcript, in tabs", async () => {
		await browser.metrics(1400, 860);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait(`document.querySelectorAll('.views-pane').length === 3`);
		const panes = await browser.evaluate<{ id: string; hidden: boolean; left: number }[]>(
			`[...document.querySelectorAll('.views-pane')].map(p=>({id:p.dataset.viewPane,hidden:p.hidden,left:p.getBoundingClientRect().left}))`,
		);
		const [chatPane, plan, glyph] = panes;
		assert.deepEqual(
			panes.map((pane) => [pane.id, pane.hidden]),
			[
				["transcript", false],
				["plan", true],
				["glyph", false],
			],
		);
		assert.ok(chatPane && plan && glyph && glyph.left > chatPane.left);
		assert.deepEqual(
			await browser.evaluate<string[]>(`[...document.querySelectorAll('.views-tab')].map(t=>t.textContent)`),
			["Chat", "Plan", "Glyph editor"],
		);
	});

	it("gives an html page its state, saves the person's changes and selection, and follows the agent's", async () => {
		await browser.wait(`document.querySelector('.views-frame')`);
		const frame = (expression: string) => browser.evaluateInFrame<string>("/artifact-frame", expression);
		await poll(
			() =>
				frame("document.getElementById('title').textContent")
					.then((title) => title === "Glyph a")
					.catch(() => false),
			20_000,
			"the frame drew its initial state",
		);
		assert.equal(await frame("window.lastFrom"), "init");
		await browser.evaluateInFrame("/artifact-frame", `document.querySelector('[data-i="1"]').click()`);
		const page = await holdIn(fixture.browser(), ArtifactPage, { session, id: "glyph" }, "editor");
		await until(page.value, (value) => (value as { selected?: number } | null)?.selected === 1);
		await browser.wait(`document.querySelector('.views-chip')?.textContent.includes('Selection in Glyph editor')`);
		const [view] = (await until(views.views, (list) => list.some((each) => each.selection))).filter(
			(each) => each.selection,
		);
		assert.deepEqual([view?.id, view?.selection?.summary], ["glyph", "point 1 of glyph a"]);
		// Dropped from the next message (the chip's ×): the fake provider reads the message as the script.
		await browser.click(".views-chip > button");
		await browser.wait(`!document.querySelector('.views-chip')`);
		// The agent reads the whole state as an object and replaces it: the page draws it.
		const result = await script(
			[
				`const { state } = await tools.artifact_html_state({ id: "glyph" });`,
				`await tools.artifact_html_set_state({ id: "glyph", state: { ...state, glyph: "b" } });`,
				"return state.selected;",
			].join("\n"),
		);
		assert.match(JSON.stringify(result?.content), /1/);
		await poll(
			() => frame("document.getElementById('title').textContent").then((title) => title === "Glyph b"),
			20_000,
			"the frame drew the agent's state",
		);
		assert.equal(await frame("window.lastFrom"), "update");
		assert.deepEqual(page.value.value, {
			glyph: "b",
			points: [
				[0, 0],
				[1, 1],
				[2, 0],
			],
			selected: 1,
		});
		page.release();
	});

	it("comments on selected text and draws over a pane", async () => {
		const plan = await browser.evaluate<{ x: number; y: number }>(tabCentre("Plan"));
		await mouse("mousePressed", plan.x, plan.y);
		await mouse("mouseReleased", plan.x, plan.y);
		await browser.wait(`document.querySelector('[data-view-pane="plan"]:not([hidden]) strong')`);
		await browser.click(".views-annotate-toggle");
		await browser.evaluate(
			`(() => { const r=document.createRange(); r.selectNodeContents(document.querySelector('[data-view-pane="plan"] strong')); getSelection().removeAllRanges(); getSelection().addRange(r); })()`,
		);
		await browser.click(".views-annotate-bar > button:first-child");
		await browser.wait(`document.querySelector('.views-comment textarea')`);
		await browser.evaluate(
			`(() => { const t=document.querySelector('.views-comment textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'capital A'); t.dispatchEvent(new Event('input',{bubbles:true})); })()`,
		);
		await browser.click(".views-comment button[type=submit]");
		const [comment] = await until(views.annotations, (value) => value.length === 1);
		assert.deepEqual(
			[comment?.kind, comment?.view, comment?.quote, comment?.note],
			["comment", "plan", "letter a", "capital A"],
		);
		await browser.wait(`CSS.highlights.get('p2-note')?.size === 1`);
		// Draw over the chat: the drawing names the transcript and what it covers.
		await browser.click(".views-annotate-bar > button:nth-child(3)");
		await browser.wait(`document.querySelector('.views-ink-input')`);
		const chatBox = await browser.evaluate<{ x: number; y: number }>(
			`(() => {const r=document.querySelector('[data-view-pane="transcript"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
		await mouse("mousePressed", chatBox.x - 60, chatBox.y);
		for (let step = 1; step <= 12; step++)
			await mouse("mouseMoved", chatBox.x - 60 + step * 10, chatBox.y + (step % 2 ? 20 : -20));
		await mouse("mouseReleased", chatBox.x + 60, chatBox.y);
		const notes = await until(views.annotations, (value) => value.length === 2, 10_000);
		assert.deepEqual([notes[1]?.kind, notes[1]?.view], ["ink", "transcript"]);
		await browser.wait(`document.querySelector('[data-view-pane="transcript"] .views-ink polyline')`);
		await browser.click(".views-annotate-bar > button:last-child");
		await browser.wait(`!document.querySelector('.views-annotate-bar')`);
	});

	it("drags a tab beside another area", async () => {
		const glyph = await browser.evaluate<{ x: number; y: number }>(tabCentre("Glyph editor"));
		const target = await browser.evaluate<{ x: number; y: number }>(
			`(() => {const r=document.querySelector('[data-view-pane="transcript"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-40}})()`,
		);
		await mouse("mousePressed", glyph.x, glyph.y);
		for (let step = 1; step <= 10; step++)
			await mouse(
				"mouseMoved",
				glyph.x + ((target.x - glyph.x) * step) / 10,
				glyph.y + ((target.y - glyph.y) * step) / 10,
			);
		await browser.wait(`document.querySelector('.views-drop')`);
		await mouse("mouseReleased", target.x, target.y);
		await browser.wait(`!document.querySelector('.views-drag-cover')`);
		const boxes = await browser.evaluate<Record<string, { left: number; top: number }>>(
			`Object.fromEntries([...document.querySelectorAll('.views-pane:not([hidden])')].map(p=>{const r=p.getBoundingClientRect();return [p.dataset.viewPane,{left:r.left,top:r.top}]}))`,
		);
		// Below the chat, in its column; the plan alone on the right.
		assert.equal(boxes.glyph?.left, boxes.transcript?.left);
		assert.ok((boxes.glyph?.top ?? 0) > (boxes.transcript?.top ?? 0));
		assert.ok((boxes.plan?.left ?? 0) > (boxes.transcript?.left ?? 0));
	});

	it("adopts the agent's arrangement", async () => {
		// The notes would go with the next message, which the fake provider reads as the tool's call.
		await views.discard(BACKGROUND_CONTEXT);
		await script(`await tools.view_arrange({ layout: { column: ["plan", { row: ["transcript", "glyph"] }] } });`);
		await browser.wait(
			`(() => { const box = (id) => document.querySelector('[data-view-pane="' + id + '"]').getBoundingClientRect(); return box('plan').bottom <= box('transcript').top && box('transcript').right <= box('glyph').left; })()`,
		);
	});

	it("shows one pane at a time on phones", async () => {
		await browser.metrics(390, 844);
		await browser.wait(`document.querySelector('.views-tabs.phone')`);
		await browser.evaluate(
			`[...document.querySelectorAll('.views-tabs.phone .views-tab')].find(t=>t.textContent==='Chat').click()`,
		);
		await browser.wait(
			`[...document.querySelectorAll('.views-pane:not([hidden])')].map(p=>p.dataset.viewPane).join()==='transcript'`,
		);
		await browser.evaluate(
			`[...document.querySelectorAll('.views-tabs.phone .views-tab')].find(t=>t.textContent==='Plan').click()`,
		);
		await browser.wait(
			`[...document.querySelectorAll('.views-pane:not([hidden])')].map(p=>p.dataset.viewPane).join()==='plan'`,
		);
	});
});
