// `/tree` in the browser (docs/tree.md): "Edit" on a user message (a branch before it, its text in the composer),
// "Branch from here" on an answer, the branch rows under the session in the sidebar (stored labels, the session title
// for conversation 1) and renaming them, and following a switch made elsewhere.

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

describe("branches in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, id: string;
	const send = async (conversation: number, text: string) => {
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation }, "participant");
		await chat.send({ text, requestId: `${conversation}:${text}` }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`) && idle(view));
		chat.release();
	};
	const row = async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		return (await until(sessions.sessions, (list) => Boolean(list?.some((each) => each.id === id)))).find(
			(each) => each.id === id,
		)!;
	};
	before(async () => {
		fixture = await startFixture({ web: true });
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		id = (await sessions.create({ cwd: fixture.workspace, title: "Branches" }, BACKGROUND_CONTEXT)).id;
		await send(1, "first");
		await send(1, "second");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("edits a user message into a branch, lists the branches and switches between them", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: second')`);
		// One branch: no branch rows and no expand control yet.
		assert.equal(
			await browser.evaluate<number>(
				`document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row').length`,
			),
			0,
		);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.subagent-toggle').length`), 0);
		await browser.evaluate(
			`[...document.querySelectorAll('.user')].find(e=>e.textContent.includes('second')).querySelector('[aria-label=Edit]').click()`,
		);
		await browser.wait(`document.querySelector('.composer textarea')?.value==='second'`);
		const main = (await until((await holdIn(fixture.browser(), Sessions, {}, "owner")).sessions, (list) =>
			Boolean(list?.find((each) => each.id === id && each.main !== 1)),
		))!.find((each) => each.id === id)!.main;
		await browser.wait(`location.pathname==='/s/${id}/c/${main}'`);
		await browser.wait(
			`document.querySelector('.messages')?.textContent.includes('Echo: first') && !document.querySelector('.messages').textContent.includes('Echo: second')`,
		);
		// The fork has a row at once, newest first, labelled with the edited message; conversation 1 shows the title. The
		// rows wait hidden behind the arrow after the session's title (here without subagents), which shows them.
		await browser.wait(`document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row').length===2`);
		const header = `document.querySelector('.sidebar-section[data-key=recent] .session-header')`;
		const toggle = `${header}.querySelector('.subagent-toggle')`;
		const branches = `document.getElementById(${toggle}.getAttribute('aria-controls'))`;
		assert.equal(await browser.evaluate<boolean>(`${branches}.hidden`), true);
		await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`!${branches}.hidden && ${toggle}.getAttribute('aria-expanded')==='true'`);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].map(e=>e.textContent)`,
			),
			["second", "Branches"],
		);
		await send(main, "other");
		// Switching back to conversation 1 from the sidebar.
		await browser.evaluate(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].find(e=>e.textContent==='Branches').click()`,
		);
		await browser.wait(`location.pathname==='/s/${id}'`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: second')`);
		assert.equal((await row()).main, 1);
		// The rows keep their order. They stay shown across the switch; the main conversation is selected on the session's
		// row, not on its branch's.
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].map(e=>e.textContent+(e.classList.contains('active')?'*':'')).join('|')==='second|Branches' && document.querySelector('.sidebar-section[data-key=recent] .nav-row.selected > .session-main')`,
		);
		assert.equal(await browser.evaluate<boolean>(`${branches}.hidden`), false);
		// Collapsing hides them again.
		await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`${branches}.hidden && ${toggle}.getAttribute('aria-expanded')==='false'`);
		await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`!${branches}.hidden`);
	});

	it("renames a branch from its row; conversation 1 follows the session title until renamed", async () => {
		const rows = () =>
			browser.evaluate<string>(
				`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].map(e=>e.textContent).join('|')`,
			);
		const rename = async (label: string, text: string) => {
			await browser.evaluate(
				`document.querySelector('.branch-rename[aria-label="Rename branch ${label}"]').click()`,
			);
			await browser.wait(`document.querySelector('.sheet input')?.value===${JSON.stringify(label)}`);
			await browser.evaluate(
				`(()=>{const e=document.querySelector('.sheet input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
			);
			await browser.evaluate(`document.querySelector('.sheet button[type="submit"]').click()`);
			await browser.wait(`!document.querySelector('.sheet')`);
		};
		await rename("second", "Second try");
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].some(e=>e.textContent==='Second try')`,
		);
		// A session rename reaches conversation 1's row.
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		await sessions.rename({ id, title: "Renamed" }, BACKGROUND_CONTEXT);
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].some(e=>e.textContent==='Renamed')`,
		);
		await rename("Renamed", "Main line");
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].some(e=>e.textContent==='Main line')`,
		);
		assert.equal(await rows(), "Second try|Main line");
		assert.equal((await row()).branches.find((branch) => branch.conversation === 1)?.label, "Main line");
		// Back to the session title.
		await browser.evaluate(`document.querySelector('.branch-rename[aria-label="Rename branch Main line"]').click()`);
		await browser.evaluate(
			`[...document.querySelectorAll('.sheet button')].find(e=>e.textContent==='Use the session title').click()`,
		);
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].some(e=>e.textContent==='Renamed')`,
		);
	});

	it("branches after an answer, and follows a switch made elsewhere", async () => {
		await browser.evaluate(
			`[...document.querySelectorAll('.assistant')].find(e=>e.textContent.includes('Echo: first')).querySelector('button[aria-label="Branch from here"]').click()`,
		);
		await browser.wait(`location.pathname.startsWith('/s/${id}/c/')`);
		await browser.wait(
			`document.querySelector('.messages')?.textContent.includes('Echo: first') && !document.querySelector('.messages').textContent.includes('Echo: second')`,
		);
		const tree = await holdIn(fixture.browser(), SessionTree, { session: id }, "owner");
		await tree.select({ conversation: 1 }, BACKGROUND_CONTEXT);
		await browser.wait(`location.pathname==='/s/${id}'`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: second')`);
	});
});
