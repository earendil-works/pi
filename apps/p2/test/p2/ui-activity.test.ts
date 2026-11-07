// Browser: a run of tool calls opens in p2's own sheet (grip, header with the count and time, close) as a route layer:
// a call's detail one layer up with Back in the header, and the browser's Back leads down again, then closes the
// sheet. On a wide screen it is p2's centred dialog. A turn's thought and texts stay in the transcript in order, one
// wheel per run of calls, and each wheel's sheet lists only its run; a long run opens on its newest calls.
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
		// Detail 3: the thought in the transcript, the call alone on its wheel (the default, 2, puts the thought on it).
		const settings = join(fixture.dataDir, "settings.json");
		const base = existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>) : {};
		writeFileSync(settings, JSON.stringify({ ...base, detail: 3 }));
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

/** A response: its parts, and results for its calls ("ok <id>", or `results`' own). */
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
		// Detail 3: the thought in the transcript, only runs of calls on wheels (what these tests look at).
		await browser.evaluate(`window.showCodemode(${JSON.stringify(view)}, 3)`);
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

	it("shows a tool by its plugin's contribution, and one without any by its name and first argument", async () => {
		const entries: ConversationView["entries"][number][] = [];
		respond(entries, [
			call("t1", "bash", { command: "npm test" }),
			call("t2", "web_fetch", { limit: 3, url: "https://example.com" }),
		]);
		respond(entries, [{ type: "text", text: "Done." }], "stop");
		await show({ conversation, entries, docs: {} });
		await browser.wait("document.querySelector('[data-testid=activity][data-state=done]')");
		assert.match(
			await browser.evaluate<string>("document.querySelector('[data-testid=activity]').textContent"),
			/Ran a command, used web_fetch/,
		);
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===2");
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=step]')].map(e=>e.querySelector('.step-name').textContent+' '+e.querySelector('.step-argument').textContent)",
			),
			["bash npm test", "web_fetch https://example.com"],
		);
		// The generic detail: the input as JSON, the output.
		await browser.evaluate("document.querySelectorAll('[data-testid=step] button')[1].click()");
		await browser.wait(`${title}==='web_fetch https://example.com'`);
		assert.match(
			await browser.evaluate<string>("document.querySelector('[data-testid=detail-input]').textContent"),
			/"url": "https:\/\/example.com"/,
		);
		assert.equal(await browser.evaluate("document.querySelector('pre.detail-output').textContent"), "ok t2");
		// The coding tools plugin's: the command as a terminal.
		await browser.evaluate("history.back()");
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===2");
		await browser.evaluate("document.querySelectorAll('[data-testid=step] button')[0].click()");
		await browser.wait(`${title}==='Ran npm test' && document.querySelector('[data-testid=detail-command]')`);
		await browser.evaluate("history.back()");
		await browser.evaluate("history.back()");
		await browser.wait(`!${sheet}`);
	});

	it("shows the coding tools' own details: a command as a terminal, a read's numbered lines, an edit's diff", async () => {
		const entries: ConversationView["entries"][number][] = [];
		const output = Array.from({ length: 60 }, (_, line) => `line ${line + 1}`).join("\n");
		respond(
			entries,
			[
				call("b", "bash", { command: "npm test" }),
				call("r", "read", { path: "src/a.ts", offset: 40, limit: 2 }),
				call("e", "edit", { path: "src/a.ts", edits: [] }),
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
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===3");
		assert.equal(
			await browser.evaluate("document.querySelector('[data-testid=step] .step-state').textContent"),
			"✗ exit 1",
		);
		const open = async (index: number) => {
			await browser.evaluate(`document.querySelectorAll('[data-testid=step] button')[${index}].click()`);
			await browser.wait(`${sheet}?.querySelector('.sheet-head [aria-label=Back]')`);
		};
		// bash: the command after its prompt, the whole output (no "Show all"), red.
		await open(0);
		assert.equal(
			await browser.evaluate("document.querySelector('[data-testid=detail-command]').textContent"),
			"$ npm test",
		);
		const terminal = await browser.evaluate<{ text: string; failed: boolean; more: boolean }>(
			"(t=>({text:t.querySelector('pre.detail-output').textContent,failed:t.dataset.failed==='true',more:Boolean(document.querySelector('.detail-more'))}))(document.querySelector('[data-testid=detail-output] .detail-terminal'))",
		);
		assert.ok(terminal.text.startsWith("line 1\n") && terminal.text.endsWith("Command exited with code 1"));
		assert.deepEqual([terminal.failed, terminal.more], [true, false]);
		await browser.evaluate("history.back()");
		// read: the file's lines, numbered from where the read started.
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===3");
		await open(1);
		assert.equal(
			await browser.evaluate("document.querySelector('.detail-path').textContent"),
			"src/a.ts · lines 40–41",
		);
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=detail-output] .diff-line')].map(e=>e.querySelector('.diff-number').textContent+':'+e.querySelector('.diff-code').textContent)",
			),
			["40:const a = 1;", "41:const b = 2;"],
		);
		await browser.evaluate("history.back()");
		// edit: the diff, its lines marked removed and added.
		await browser.wait("document.querySelectorAll('[data-testid=step]').length===3");
		await open(2);
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=detail-output] pre.diff .diff-line')].map(e=>e.className.replace('diff-line','').trim()+':'+e.textContent.trim())",
			),
			["del:-40 const a = 1;", "add:+40 const a = 3;"],
		);
		await browser.evaluate("history.back()");
		await browser.evaluate("history.back()");
		await browser.wait(`!${sheet}`);
	});

	it("updates a running call's detail live, as its output streams", async () => {
		const running = (output: string): ConversationView => {
			const message: AssistantMessage = {
				...fauxAssistantMessage([]),
				content: [call("live", "bash", { command: "npm test" })],
				stopReason: "toolUse",
				timestamp: 1,
			};
			return {
				conversation,
				entries: [{ id: 1 as EntryId, conversationId: conversation.id, kind: "pi.assistant", model: [message] }],
				docs: {
					"pi.live": {
						run: { taskId: 1, inputs: [] },
						tools: [{ callId: "live", name: "bash", taskId: 1, status: "running", output }],
					} as unknown as LiveState,
				} as ConversationView["docs"],
			};
		};
		await show(running("building\n"));
		await browser.click("[data-testid=activity]");
		await browser.wait("document.querySelector('[data-testid=step] .step-state')?.textContent==='● running'");
		await browser.click("[data-testid=step] button");
		await browser.wait("document.querySelector('pre.detail-output')?.textContent==='building'");
		await browser.evaluate(`window.showCodemode(${JSON.stringify(running("building\ntesting\n"))})`);
		await browser.wait("document.querySelector('pre.detail-output')?.textContent==='building\\ntesting'");
		await browser.evaluate("history.back()");
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
