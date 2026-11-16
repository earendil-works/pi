// The tree panel in the browser (docs/tree.md, "Tree panel"): the top bar's button opens the session's turns in every
// branch as a table of contents in the side panel, oldest first, the current branch at the top level and the others
// inset; its indicator on the turn in view; choosing another branch's turn switches the session to that branch and
// shows the turn; the panel follows the switch and offers no actions; the chosen turn stays marked until the reader scrolls.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const idle = (view: { docs: Record<string, unknown> } | null | undefined) =>
	!(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run;

/** A page function: the panel's turns as "depth current|inset [refs] message / answer". */
const TURNS = `[...document.querySelectorAll('[data-testid=tree-panel] .tree-toc a')].map((link) => { const item = link.parentElement; let depth = -1; for (let at = item; at; at = at.parentElement) if (at.tagName === 'OL') depth++; return depth + ' ' + item.className.split(' ').filter((name) => name === 'current' || name === 'inset').join('') + [...link.querySelectorAll('.tree-ref')].map((ref) => ' [' + ref.textContent + ']').join('') + ' ' + link.querySelector('.tree-text').textContent + (link.querySelector('.tree-answer') ? ' / ' + link.querySelector('.tree-answer').textContent : ''); })`;

describe("the tree panel", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, id: string, long: string;
	const send = async (session: string, conversation: number, text: string) => {
		const chat = await holdIn(fixture.browser(), Chat, { session, conversation }, "participant");
		await chat.send({ text, requestId: `${conversation}:${text}` }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`) && idle(view));
		chat.release();
	};
	/** A session with `words` sent in conversation 1, then a branch from the first answer with "other" in it (main). */
	const graph = async (title: string, words: readonly string[]) => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = (await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
		sessions.release();
		for (const word of words) await send(session, 1, word);
		const tree = await holdIn(fixture.browser(), SessionTree, { session }, "owner");
		const nodes = (await tree.tree(BACKGROUND_CONTEXT)).nodes;
		const answer = nodes.find((node) => node.text === `Echo: ${words[0]}`);
		assert(answer);
		const { conversation } = await tree.navigate({ entry: answer.entry }, BACKGROUND_CONTEXT);
		tree.release();
		await send(session, conversation, "other");
		return session;
	};
	before(async () => {
		fixture = await startFixture({ web: true });
		id = await graph("Graph", ["first", "second"]);
		// Long enough to scroll: a revealed turn is centred, except near the transcript's end.
		long = await graph("Long", ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("draws every branch, oldest first, and switches to the branch storing a chosen turn", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: other')`);
		await browser.click(`.topbar button[aria-label="Conversation tree"]`);
		await browser.wait(`document.querySelectorAll('[data-testid=tree-panel] .tree-toc a').length === 3`);
		// Oldest first: the current branch at the top level, conversation 1's own turn inset under the turn it left.
		assert.deepEqual(await browser.evaluate<string[]>(TURNS), [
			"0 current first / Echo: first",
			"1 inset [Graph] second / Echo: second",
			"0 current [Current: Echo: first] other / Echo: other",
		]);
		// The transcript shows its end: the indicator is on the last turn.
		await browser.wait(
			`document.querySelector('[data-testid=tree-panel] a[data-active] .tree-text')?.textContent === 'other'`,
		);

		// Conversation 1's turn: choosing it switches the session to conversation 1 and shows the turn; no actions.
		await browser.click(`[data-testid=tree-panel] .inset > a`);
		await browser.wait(
			`document.querySelector('[data-testid=tree-panel] .tree-ref.main')?.textContent === 'Current: Graph'`,
		);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: second')`);
		assert.equal(
			await browser.evaluate<number>(
				`document.querySelectorAll('[data-testid=tree-panel] .tree-toc button').length`,
			),
			0,
		);
		assert.deepEqual(await browser.evaluate<string[]>(TURNS), [
			"0 current first / Echo: first",
			"1 inset [Echo: first] other / Echo: other",
			"0 current [Current: Graph] second / Echo: second",
		]);

		// The button closes the panel.
		await browser.click(`.topbar button[aria-label="Conversation tree"]`);
		await browser.wait(`!document.querySelector('[data-testid=tree-panel]')`);
	});

	it("marks the chosen turn, on a switch and near the transcript's end, until the reader scrolls", async () => {
		await browser.metrics(1280, 600);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${long}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: other')`);
		await browser.click(`.topbar button[aria-label="Conversation tree"]`);
		await browser.wait(`document.querySelectorAll('[data-testid=tree-panel] .tree-toc a').length === 9`);
		const choose = (text: string) =>
			browser.evaluate(
				`[...document.querySelectorAll('[data-testid=tree-panel] .tree-toc a')].find((link) => link.querySelector('.tree-text').textContent === ${JSON.stringify(text)}).click()`,
			);
		const marked = (text: string) =>
			browser.wait(
				`document.querySelector('[data-testid=tree-panel] a[data-active] .tree-text')?.textContent === ${JSON.stringify(text)} && document.querySelector('.messages')?.textContent.includes('Echo: ${text}')`,
			);
		const settled = () => new Promise((resolve) => setTimeout(resolve, 600));
		// Another branch's turn in the middle: the session switches to conversation 1, the turn is centred and marked.
		await choose("fifth");
		await marked("fifth");
		await settled();
		await marked("fifth");
		// A turn of the current branch.
		await choose("third");
		await settled();
		await marked("third");
		// The reader scrolls to the top: the mark follows the transcript again ("second" starts above its middle).
		const box = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const box = document.querySelector('.scroller.transcript').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...box, deltaX: 0, deltaY: -3000 });
		await browser.wait(
			`document.querySelector('[data-testid=tree-panel] a[data-active] .tree-text')?.textContent === 'second'`,
		);
		// The last turn of another branch: the transcript ends there, so it cannot be scrolled to the middle.
		await choose("other");
		await settled();
		await marked("other");
	});
});
