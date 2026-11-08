// Browser: messages that are not the owner's and not the agent's own (a subagent's answer, question, note or failure,
// another session's message, a guest's) share one shape: a header line "icon name · what · time" and the body as
// Markdown under it, without coloured edges; long bodies collapse with "Show more". A subagent's header opens its
// conversation and another session's header that session, and Back returns. Fake provider, disposable data.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ConversationView, EntryId, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const conversation = { id: 1 } as ConversationView["conversation"];
const AT = Date.UTC(2026, 0, 2, 10, 30);

/** A user-role entry of `kind` with `data`: what the worker writes for inputs, agents' and peers' messages. */
function entry(
	id: number,
	kind: string,
	data: Record<string, unknown>,
	text: string,
): ConversationView["entries"][number] {
	return {
		id: id as EntryId,
		conversationId: conversation.id,
		kind,
		model: [{ role: "user", content: [{ type: "text", text }], timestamp: AT + id * 60_000 }],
		data: data as never,
	};
}

const agent = (id: number, intent: string, text: string) =>
	entry(id, "p2.agent-message", { from: { name: "helper", conversationId: 2 }, intent, text }, text);

function incomingView(): ConversationView {
	return {
		conversation,
		docs: {},
		entries: [
			entry(
				1,
				"p2.input",
				{ author: { kind: "owner", id: "owner", name: "Mario" }, text: "Hi all", attachments: [] },
				"Hi all",
			),
			agent(2, "answered", "Done: **all** tests pass."),
			agent(3, "question", "Which branch?"),
			agent(4, "failed", "Error: boom"),
			entry(5, "p2.peer-message", { from: { id: "session-b", title: "Release notes" }, text: "Check *this*." }, "x"),
			entry(
				6,
				"p2.input",
				{ author: { kind: "guest", id: "g1", name: "Alice" }, text: "Hello **there**", attachments: [] },
				"x",
			),
			agent(7, "note", Array.from({ length: 30 }, (_, line) => `Line ${line + 1}`).join("\n\n")),
		],
	};
}

describe("incoming messages", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(390, 844);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("renders every incoming kind with one header shape, no side edges, and collapses long bodies", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}`);
		await browser.wait("document.querySelector('.app')");
		await browser.loadFixture("incoming.ts");
		await browser.wait("typeof window.showIncoming==='function'");
		await browser.evaluate(`window.showIncoming(${JSON.stringify(incomingView())})`);
		await browser.wait("document.querySelectorAll('[data-testid=incoming]').length===6");
		// The owner's message keeps its bubble.
		assert.equal(await browser.evaluate("document.querySelector('.user .bubble')?.textContent"), "MarioHi all");
		const lines = await browser.evaluate<string[]>(
			"[...document.querySelectorAll('[data-testid=incoming] .incoming-line')].map(e=>e.textContent.replace(/ · [^·]*$/, ''))",
		);
		assert.deepEqual(lines, [
			"helper · answered",
			"helper · asks",
			"helper · failed",
			"Release notes · wrote",
			"Alice · (guest) wrote",
			"helper · wrote",
		]);
		// Each line ends with the time.
		assert.ok(
			await browser.evaluate<boolean>(
				"[...document.querySelectorAll('.incoming-line')].every(e=>/ · [^·]*\\d{1,2}:\\d{2}[^·]*$/.test(e.textContent))",
			),
		);
		// No side edges anywhere, one colour for every kind's header and name.
		assert.equal(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=incoming], [data-testid=incoming] *')].filter(e=>getComputedStyle(e).borderLeftWidth!=='0px').length",
			),
			0,
		);
		const colours = await browser.evaluate<string[]>(
			"[...new Set([...document.querySelectorAll('.incoming-from')].map(e=>getComputedStyle(e).color+'|'+getComputedStyle(e.querySelector('.incoming-name')).color))]",
		);
		assert.equal(colours.length, 1, JSON.stringify(colours));
		// Headers with a target are buttons at least 44px tall with a chevron; a guest's has neither.
		assert.deepEqual(
			await browser.evaluate(
				"[...document.querySelectorAll('[data-testid=incoming]')].map(e=>[e.dataset.from, e.querySelector('button.incoming-from')?Math.round(e.querySelector('button.incoming-from').getBoundingClientRect().height)>=44:false, Boolean(e.querySelector('.incoming-chevron'))])",
			),
			[
				["agent", true, true],
				["agent", true, true],
				["agent", true, true],
				["session", true, true],
				["guest", false, false],
				["agent", true, true],
			],
		);
		// The body is Markdown, indented under the name, and not a link.
		assert.equal(
			await browser.evaluate("document.querySelector('[data-from=agent] .incoming-body strong')?.textContent"),
			"all",
		);
		assert.equal(
			await browser.evaluate("document.querySelector('[data-from=guest] .incoming-body strong')?.textContent"),
			"there",
		);
		assert.equal(
			await browser.evaluate("[...document.querySelectorAll('.incoming-body')].every(e=>!e.closest('button, a'))"),
			true,
		);
		const indent = await browser.evaluate<number>(
			"(e=>e.querySelector('.incoming-body').getBoundingClientRect().left-e.getBoundingClientRect().left)(document.querySelector('[data-from=agent]'))",
		);
		assert.ok(indent >= 20 && indent <= 32, `body indented ${indent}px`);
		// A long body is cut until "Show more".
		const long = "[...document.querySelectorAll('[data-testid=incoming]')].at(-1)";
		await browser.wait(`${long}.querySelector('.incoming-more')?.textContent==='Show more'`);
		assert.ok(
			await browser.evaluate<boolean>(
				`(b=>b.scrollHeight>b.clientHeight+50)(${long}.querySelector('.incoming-body'))`,
			),
		);
		await browser.evaluate(`${long}.querySelector('.incoming-more').click()`);
		await browser.wait(
			`${long}.querySelector('.incoming-body').textContent.includes('Line 30') && !${long}.querySelector('.incoming-body.clamped')`,
		);
		// The headers open where the message came from.
		await browser.click("[data-from=agent] button.incoming-from");
		await browser.click("[data-from=session] button.incoming-from");
		assert.deepEqual(await browser.evaluate("window.opened"), ["conversation:2", "session:session-b"]);
	});

	it("opens a subagent's conversation and another session from a message's header; Back returns", async () => {
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const alpha = (await sessions.create({ cwd: fixture.workspace, title: "Alpha" }, BACKGROUND_CONTEXT)).id;
		const beta = (await sessions.create({ cwd: fixture.workspace, title: "Beta" }, BACKGROUND_CONTEXT)).id;
		const a = await holdIn(owner, Chat, { session: alpha, conversation: 1 }, "participant");
		const b = await holdIn(owner, Chat, { session: beta, conversation: 1 }, "participant");
		const list = await holdIn(owner, Subagents, {}, "reader");
		await a.send({ text: "subagent", requestId: "spawn" }, BACKGROUND_CONTEXT);
		const children = await until(list.children, (value) => value?.[alpha]?.length === 1);
		const helper = children![alpha]![0]!;
		await until(
			a.view,
			(view) => !live(view)?.run && JSON.stringify(view).includes("Echo: [answered, no reply needed]"),
			30_000,
		);
		await a.send(
			{
				text: `conversations ${JSON.stringify({ action: "send", to: beta, message: "hello peer" })}`,
				requestId: "peer",
			},
			BACKGROUND_CONTEXT,
		);
		await until(b.view, (view) => JSON.stringify(view?.entries ?? []).includes("p2.peer-message"), 30_000);
		await until(a.view, (view) => !live(view)?.run, 30_000);
		a.release();
		b.release();

		// The subagent's answer in the main conversation.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${alpha}`);
		await browser.wait(
			"document.querySelector('[data-from=agent] button.incoming-from') && !document.querySelector('.offline')",
		);
		assert.match(
			await browser.evaluate<string>("document.querySelector('[data-from=agent] .incoming-line').textContent"),
			/^helper · answered · /,
		);
		// The turns after it may have scrolled it under the header.
		await browser.evaluate(`document.querySelector('[data-from=agent]').scrollIntoView({ block: "center" })`);
		await browser.click("[data-from=agent] button.incoming-from");
		await browser.wait(`location.pathname==='/s/${alpha}/c/${helper.conversationId}'`);
		await browser.evaluate("history.back()");
		await browser.wait(`location.pathname==='/s/${alpha}' && document.querySelector('[data-from=agent]')`);

		// Another session's message opens that session.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${beta}`);
		await browser.wait(
			"document.querySelector('[data-from=session] button.incoming-from') && !document.querySelector('.offline')",
		);
		assert.match(
			await browser.evaluate<string>("document.querySelector('[data-from=session] .incoming-line').textContent"),
			/^Alpha · wrote · /,
		);
		await browser.click("[data-from=session] button.incoming-from");
		await browser.wait(`location.pathname==='/s/${alpha}'`);
		await browser.evaluate("history.back()");
		await browser.wait(`location.pathname==='/s/${beta}' && document.querySelector('[data-from=session]')`);
	});
});
