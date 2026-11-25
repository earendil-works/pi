// `/tree` in the browser (docs/tree.md): "Edit" on a user message (a branch before it, its text in the composer),
// renaming a branch from the tree panel (its label is the command menu's target: "Rename branch…"), "Branch from here"
// on an answer (not the last one), following a switch made elsewhere, and sending in a new branch (Alt+Enter, Send's
// long press, right-click or ArrowUp).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import { Browser, browserTests, COMPOSER, composerText, setComposer } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const idle = (view: { docs: Record<string, unknown> } | null | undefined) =>
	!(view?.docs["pi.live"] as { run?: unknown } | undefined)?.run;

describe("branches in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, id: string;
	const send = async (conversation: number, text: string, session = id) => {
		const chat = await holdIn(fixture.browser(), Chat, { session, conversation }, "participant");
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

	it("edits a user message into a branch: its text in the composer, the fork the main conversation", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: second')`);
		await browser.evaluate(
			`[...document.querySelectorAll('.user')].find(e=>e.textContent.includes('second')).querySelector('[aria-label=Edit]').click()`,
		);
		await browser.wait(`${composerText}==='second'`);
		const main = (await until((await holdIn(fixture.browser(), Sessions, {}, "owner")).sessions, (list) =>
			Boolean(list?.find((each) => each.id === id && each.main !== 1)),
		))!.find((each) => each.id === id)!.main;
		await browser.wait(`location.pathname==='/s/${id}/c/${main}'`);
		await browser.wait(
			`document.querySelector('.messages')?.textContent.includes('Echo: first') && !document.querySelector('.messages').textContent.includes('Echo: second')`,
		);
		// The fork is labelled with the edited message.
		assert.deepEqual(
			(await row()).branches.find((branch) => branch.conversation === main),
			{ conversation: main, label: "second", parent: 1 },
		);
		// A message of its own, where the tree panel shows the branch; then back to conversation 1, where the next cases
		// start.
		await send(main, "other");
		const tree = await holdIn(fixture.browser(), SessionTree, { session: id }, "owner");
		await tree.select({ conversation: 1 }, BACKGROUND_CONTEXT);
		tree.release();
		await browser.wait(`location.pathname==='/s/${id}'`);
	});

	it("renames a branch from the tree panel: its label is the command menu's target, Rename branch… opens the sheet", async () => {
		const fork = (await row()).branches.find((branch) => branch.label === "second")!.conversation;
		await browser.click(`.topbar button[aria-label="Conversation tree"]`);
		const label = `[...document.querySelectorAll('[data-testid=tree-panel] .tree-ref')].find(e=>e.textContent==='second')`;
		await browser.wait(label);
		// Hovering the label makes its branch the menu's target; Cmd+K (Ctrl+K) opens the menu on it.
		const at = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = ${label}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
		const mac = await browser.evaluate<boolean>(`/Mac|iPhone|iPad/.test(navigator.platform)`);
		const k = { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: mac ? 4 : 2 };
		await browser.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
		await browser.call("Input.dispatchKeyEvent", { type: "keyUp", ...k });
		await browser.wait(`document.querySelector('.command-menu .command-chip')?.textContent==='Branch · second'`);
		const option = `[...document.querySelectorAll('.command-menu [role=option]')].find(e=>e.querySelector('.command-title')?.textContent==='Rename branch…')`;
		await browser.wait(option);
		await browser.evaluate(`${option}.click()`);
		// The sheet: its field focused, its text selected.
		await browser.wait(
			`(() => { const e = document.querySelector('.sheet input'); return e?.value==='second' && document.activeElement === e && e.selectionStart === 0 && e.selectionEnd === e.value.length; })()`,
		);
		await browser.evaluate(
			`(()=>{const e=document.querySelector('.sheet input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Second try');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
		);
		await browser.evaluate(`document.querySelector('.sheet button[type="submit"]').click()`);
		await browser.wait(
			`!document.querySelector('.sheet') && [...document.querySelectorAll('[data-testid=tree-panel] .tree-ref')].some(e=>e.textContent==='Second try')`,
		);
		assert.equal((await row()).branches.find((branch) => branch.conversation === fork)?.label, "Second try");
		await browser.click(`.topbar button[aria-label="Conversation tree"]`);
		await browser.wait(`!document.querySelector('[data-testid=tree-panel]')`);
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

	it("sends in a new branch with Alt+Enter, Send's long press, right-click or ArrowUp; a tap sends; the last answer offers no Branch", async () => {
		// A known last answer to start from (the tests before leave other messages at the end).
		await send(1, "last answer");
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: last answer')`);
		const answer = (text: string) =>
			`[...document.querySelectorAll('.assistant')].find(e=>e.textContent.includes(${JSON.stringify(text)}))`;
		await browser.wait(`${answer("Echo: first")}?.querySelector('button[aria-label="Branch from here"]')`);
		assert.equal(
			await browser.evaluate<boolean>(
				`Boolean(${answer("Echo: last answer")}.querySelector('[aria-label="Branch from here"]'))`,
			),
			false,
		);
		const before = (await row()).branches.length;
		// Alt+Enter: a fork of conversation 1 at its end becomes the main conversation, labelled with the message.
		await browser.evaluate(setComposer("a side question"));
		await browser.evaluate(
			`document.querySelector('${COMPOSER}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true}))`,
		);
		await browser.wait(`location.pathname.startsWith('/s/${id}/c/')`);
		await browser.wait(
			`document.querySelector('.messages')?.textContent.includes('Echo: a side question') && document.querySelector('.messages').textContent.includes('Echo: last answer')`,
		);
		assert.equal(await browser.evaluate<string>(composerText), "");
		const branched = await row();
		assert.notEqual(branched.main, 1);
		assert.equal(branched.branches.length, before + 1);
		assert.deepEqual(branched.branches[0], { conversation: branched.main, label: "a side question", parent: 1 });
		// Conversation 1 still ends at its last answer.
		const tree = await holdIn(fixture.browser(), SessionTree, { session: id }, "owner");
		const nodes = (await tree.tree(BACKGROUND_CONTEXT)).nodes;
		assert.equal(nodes.findLast((node) => node.conversation === 1)?.text, "Echo: last answer");
		// One Send button: from the keyboard, ArrowUp on it lists both ways and focuses the first; Escape closes the
		// list and returns to Send.
		await browser.wait(
			`document.querySelector('.messages .assistant:last-of-type') && !document.querySelector('.composer button.stop')`,
		);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.composer-bar button').length`), 2);
		const options = `[...document.querySelectorAll('.send-options [role=menuitem]')]`;
		const key = async (name: string, code: number) => {
			await browser.call("Input.dispatchKeyEvent", {
				type: "rawKeyDown",
				key: name,
				code: name,
				windowsVirtualKeyCode: code,
			});
			await browser.call("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: name,
				code: name,
				windowsVirtualKeyCode: code,
			});
		};
		await browser.evaluate(setComposer("from the menu"));
		await browser.evaluate(`document.querySelector('.composer button.send').focus()`);
		await key("ArrowUp", 38);
		await browser.wait(`document.activeElement === ${options}[0]`);
		assert.deepEqual(await browser.evaluate<string[]>(`${options}.map(e=>e.querySelector('span').textContent)`), [
			"Send",
			"Send in a new branch",
		]);
		assert.equal(
			await browser.evaluate<string>(
				`document.querySelector('.composer button.send').getAttribute('aria-expanded')`,
			),
			"true",
		);
		await key("Escape", 27);
		await browser.wait(
			`!document.querySelector('.send-options') && document.activeElement === document.querySelector('.composer button.send')`,
		);
		// A touch: a long press on Send opens the list without sending; its second way sends in a new branch.
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = document.querySelector('.composer button.send').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
		await new Promise((resolve) => setTimeout(resolve, 700));
		await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await browser.wait(`${options}.length === 2`);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await browser.evaluate<string>(composerText), "from the menu");
		await browser.evaluate(`${options}.find(e=>e.textContent.includes('new branch')).click()`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: from the menu')`);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		const menu = await row();
		assert.equal(menu.branches.length, before + 2);
		assert.deepEqual(menu.branches[0], { conversation: menu.main, label: "from the menu", parent: branched.main });
		await browser.wait(`location.pathname==='/s/${id}/c/${menu.main}'`);
		// It continues the branch it was sent from.
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: a side question')`);
		// A tap sends in the conversation shown.
		await browser.wait(`!document.querySelector('.composer button.stop')`);
		await browser.evaluate(setComposer("a tap"));
		await browser.click(".composer button.send");
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: a tap')`);
		assert.equal((await row()).branches.length, before + 2);
		// A right-click on Send is its context menu: the two ways for the run's state, and no browser menu.
		const rightClick = async () => {
			const at = await browser.evaluate<{ x: number; y: number }>(
				`(() => { const r = document.querySelector('.composer button.send').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
			);
			await browser.call("Input.dispatchMouseEvent", {
				type: "mousePressed",
				...at,
				button: "right",
				clickCount: 1,
			});
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				...at,
				button: "right",
				clickCount: 1,
			});
			await browser.wait(`document.activeElement === ${options}[0]`);
			return browser.evaluate<string[]>(`${options}.map(e=>e.querySelector('span').textContent)`);
		};
		await browser.wait(`!document.querySelector('.composer button.stop')`);
		await browser.evaluate(setComposer("right-clicked"));
		assert.deepEqual(await rightClick(), ["Send", "Send in a new branch"]);
		await key("Escape", 27);
		await browser.wait(`!document.querySelector('.send-options')`);
		assert.equal(await browser.evaluate<string>(composerText), "right-clicked");
		// While a run is busy: steer, or queue as a follow-up.
		await browser.evaluate(setComposer("slow busy"));
		await browser.click(".composer button.send");
		await browser.wait(`document.querySelector('.composer button.stop')`);
		await browser.evaluate(setComposer("while busy"));
		assert.deepEqual(await rightClick(), ["Steer", "Follow up"]);
		await key("Escape", 27);
		await browser.wait(`!document.querySelector('.send-options')`);
		await browser.click(".composer button.stop");
		await browser.wait(`!document.querySelector('.composer button.stop')`);
		await browser.evaluate(setComposer(""));
		tree.release();
	});
});
