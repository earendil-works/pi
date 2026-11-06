// Browser: a run of tool calls opens in p2's own sheet (grip, header with the count and time, close) as a route layer:
// a call's detail one layer up with Back in the header, and the browser's Back leads down again, then closes the
// sheet. On a wide screen it is p2's centred dialog. A turn's thought and texts stay in the transcript in order, one
// wheel per run of calls, and each wheel's sheet lists only its run; a long run opens on its newest calls.
import assert from "node:assert/strict";
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
const sheet = "document.querySelector('.sheet-layer .sheet[data-testid=activity-sheet]')";
const title = `${sheet}?.querySelector('.sheet-head h2')?.textContent`;

describe("activity sheet", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, session: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Sheet" }, BACKGROUND_CONTEXT)
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

	it("is p2's sheet: a list of calls, a call's detail with Back, and Back leads down and closes", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait("document.querySelector('[data-testid=activity]') && !document.querySelector('.offline')");
		const page = await browser.evaluate<string>("location.pathname");
		// The turn's own text and thought stay in the transcript, the call is the wheel between them.
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('.row')].map(r=>r.querySelector('[data-testid=activity]')?'activity':r.querySelector('[data-testid=thought]')?'thought':r.querySelector('.user')?'user':r.querySelector('.assistant')?.textContent.trim().slice(0,13))",
			),
			["user", "Running bash.", "activity", "thought", "Echo: bash"],
		);
		await browser.click("[data-testid=activity]");
		await browser.wait(sheet);
		assert.equal(await browser.evaluate(`${sheet}.querySelector('.sheet-grip')!==null`), true);
		assert.equal(
			await browser.evaluate(`${sheet}.querySelector('.sheet-head button[aria-label=Close]')!==null`),
			true,
		);
		assert.match(await browser.evaluate<string>(title), /^1 step · \d+s$/);
		const row = await browser.evaluate<{ text: string; height: number }>(
			"(b=>({text:b.textContent,height:Math.round(b.getBoundingClientRect().height)}))(document.querySelector('[data-testid=step] button'))",
		);
		assert.match(row.text, /^bashpwd✓/);
		assert.ok(row.height >= 44, `row ${row.height}px`);
		// The detail, one layer up, with Back in the header.
		await browser.click("[data-testid=step] button");
		await browser.wait(
			`${sheet}?.querySelector('.sheet-head button[aria-label=Back]') && document.querySelector('[data-testid=detail-command]')`,
		);
		assert.equal(await browser.evaluate(title), "Ran pwd");
		// The browser's Back returns to the list, then closes the sheet: the page stays.
		await browser.evaluate("history.back()");
		await browser.wait(
			`${sheet}?.querySelector('[data-testid=step]') && !${sheet}.querySelector('[aria-label=Back]')`,
		);
		await browser.click("[data-testid=step] button");
		await browser.wait("document.querySelector('[data-testid=detail-command]')");
		// The header's Back too.
		await browser.click(".sheet-head button[aria-label=Back]");
		await browser.wait(`${sheet}?.querySelector('[data-testid=step]')`);
		await browser.evaluate("history.back()");
		await browser.wait(`!${sheet}`);
		assert.equal(await browser.evaluate("location.pathname"), page);
		// Close leaves no layer behind: Back afterwards does not reopen it.
		await browser.click("[data-testid=activity]");
		await browser.wait(sheet);
		await browser.click(".sheet-head button[aria-label=Close]");
		await browser.wait(`!${sheet} && history.state?.route?.layers?.length===0`);
	});

	it("opens as p2's centred dialog on a wide screen, beside a working workspace", async () => {
		await browser.metrics(1440, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait("document.querySelector('[data-testid=activity]') && !document.querySelector('.offline')");
		assert.equal(await browser.evaluate("document.querySelector('[data-testid=side-dock]')"), null);
		await browser.click("[data-testid=activity]");
		await browser.wait(sheet);
		const box = await browser.evaluate<{ left: number; right: number }>(
			`(r=>({left:Math.round(r.left),right:Math.round(innerWidth-r.right)}))(${sheet}.getBoundingClientRect())`,
		);
		assert.ok(Math.abs(box.left - box.right) <= 2, `centred: ${JSON.stringify(box)}`);
		assert.equal(await browser.evaluate(`getComputedStyle(${sheet}.querySelector('.sheet-grip')).display`), "none");
		await browser.evaluate("history.back()");
		await browser.wait(`!${sheet}`);
		// The workspace keeps its own place and behaviour.
		await browser.click('button[aria-label="Workspace files and changes"]');
		await browser.wait("document.querySelector('.workspace')");
	});
});

const conversation = { id: 1 } as ConversationView["conversation"];

/** A response: its parts, and results for its calls (`bash`/`read`/`edit` with a command or path). */
function respond(
	entries: ConversationView["entries"][number][],
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
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

/** One turn: thought, text, two calls, text, one call, the answer. */
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

/** One turn of `count` commands, each with its result. */
function longTurn(count: number): ConversationView {
	const entries: ConversationView["entries"][number][] = [];
	for (let index = 0; index < count; index++)
		respond(entries, [call(`call-${index}`, "bash", { command: `check ${index}` })]);
	return { conversation, entries, docs: {} };
}

describe("a turn's parts", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.metrics(390, 844);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	const show = async (view: ConversationView) => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}`);
		await browser.wait("document.querySelector('.app')");
		await browser.loadFixture("codemode-card.ts");
		await browser.wait("typeof window.showCodemode==='function'");
		await browser.evaluate(`window.showCodemode(${JSON.stringify(view)})`);
	};

	it("keeps thought and texts in order, one wheel per run of calls, each opening only its run", async () => {
		await show(mixedTurn());
		await browser.wait("document.querySelectorAll('[data-testid=activity]').length===2");
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('.row')].map(r=>r.querySelector('[data-testid=activity]')?'activity':r.querySelector('[data-testid=thought]')?'thought':r.textContent.trim())",
			),
			["thought", "First the tests.", "activity", "Now the fix.", "activity", "Fixed and tested."],
		);
		// The thought opens in place.
		await browser.click("[data-testid=thought] button");
		await browser.wait("document.querySelector('.thinking-body')?.textContent==='Plan the fix.'");
		await browser.evaluate("document.querySelectorAll('[data-testid=activity]')[1].click()");
		await browser.wait(sheet);
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=step]')].map(e=>e.querySelector('.step-name').textContent)",
			),
			["edit"],
		);
		await browser.evaluate("history.back()");
		await browser.wait(`!${sheet}`);
		await browser.evaluate("document.querySelectorAll('[data-testid=activity]')[0].click()");
		await browser.wait(`${title}?.startsWith('2 steps')`);
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=step]')].map(e=>e.querySelector('.step-name').textContent)",
			),
			["bash", "read"],
		);
		// Closed again: the next page of this tab would restore the open layer.
		await browser.evaluate("history.back()");
		await browser.wait(`!${sheet}`);
	});

	it("opens a long run's list at its end, on the newest calls", async () => {
		await show(longTurn(30));
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===30");
		const body = `${sheet}.querySelector('.sheet-body')`;
		await browser.wait(`${body}.scrollHeight > ${body}.clientHeight * 1.5`);
		await browser.wait(`(p => p.scrollHeight - p.clientHeight - p.scrollTop < 2)(${body})`);
	});
});
