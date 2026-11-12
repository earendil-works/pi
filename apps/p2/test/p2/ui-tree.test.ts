// `/tree` in the browser (docs/tree.md): "Edit" on a user message (a branch before it, its text in the composer),
// "Branch from here" on an answer, the branch rows under the session in the sidebar (stored labels, the session title
// for conversation 1) and renaming them, following a switch made elsewhere, and the session's conversations: the forks
// as a tree with connector guides, the subagents as a list after it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { SessionTree } from "../../plugins/tree/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";
import { type BaselineOffset, baselineOffsets } from "./sidebar-baselines.ts";

/** A page function: a row's mark: the fork icon, the idle ring, the spinner, or none. */
const GLYPH = `((e) => e.querySelector('.nav-marker .nav-icon svg circle') ? 'fork' : e.querySelector('.nav-marker > .run-mark[data-state=idle]') ? 'ring' : e.querySelector('.nav-marker > .run-mark[data-state=working]') ? 'spinner' : 'none')`;

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
		// The fork has a row at once, labelled with the edited message; conversation 1 shows the session title. The
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
			// Conversation 1 is the tree's first row, the fork from it below.
			["Branches", "second"],
		);
		// A branch row's mark: the fork icon on a row something forked from (here conversation 1), the ring on a leaf (the
		// fork), as a subagent's; its end is empty while it is idle.
		assert.deepEqual(
			await browser.evaluate<{ icon: string; details: number }[]>(
				`[...document.querySelectorAll('.sidebar-section[data-key=recent] .nav-row:has(> .branch-row)')].map(e=>({ icon: ${GLYPH}(e), details: e.querySelectorAll('.nav-details').length }))`,
			),
			[
				{ icon: "fork", details: 0 },
				{ icon: "ring", details: 0 },
			],
		);
		// While a leaf works its ring is the spinner and its end says what it does, as a subagent's does.
		const working = await holdIn(fixture.browser(), Chat, { session: id, conversation: main }, "participant");
		await working.send({ text: "slow branch", requestId: "slow-branch" }, BACKGROUND_CONTEXT);
		const second = `[...document.querySelectorAll('.sidebar-section[data-key=recent] .nav-row:has(> .branch-row)')].find(e=>e.querySelector('.session-title').textContent==='second')`;
		await browser.wait(
			`${GLYPH}(${second}) === 'spinner' && ${second}.querySelector('.subagent-step')?.textContent==='Thinking'`,
		);
		await until(
			working.view,
			(view) => JSON.stringify(view?.entries ?? []).includes("Echo: slow branch") && idle(view),
		);
		working.release();
		await browser.wait(`${second} && !${second}.querySelector('.nav-details') && ${GLYPH}(${second}) === 'ring'`);
		await send(main, "other");
		// Switching back to conversation 1 from the sidebar; its composer takes the focus once the switch is made.
		await browser.evaluate(`document.activeElement?.blur()`);
		await browser.evaluate(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].find(e=>e.textContent==='Branches').click()`,
		);
		await browser.wait(`location.pathname==='/s/${id}'`);
		await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: second')`);
		await browser.wait(`document.activeElement === document.querySelector('.composer textarea')`);
		assert.equal((await row()).main, 1);
		// Conversation 1 working: its fork icon is framed.
		const root = `[...document.querySelectorAll('.sidebar-section[data-key=recent] .nav-row:has(> .branch-row)')].find(e=>e.querySelector('.session-title').textContent==='Branches')`;
		const first = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		await first.send({ text: "slow root", requestId: "slow-root" }, BACKGROUND_CONTEXT);
		await browser.wait(`${root}?.querySelector('.nav-marker .working-frame') && ${GLYPH}(${root}) === 'fork'`);
		// Its twig's arm ends at least 1px before the frame.
		assert(
			(await browser.evaluate<number>(
				`${root}.querySelector('.working-frame').getBoundingClientRect().left - ${root}.querySelector(':scope > .tree-guide[data-guide=elbow]').getBoundingClientRect().right`,
			)) > 0.99,
			"the arm ends clear of the working frame",
		);
		await first.stop(BACKGROUND_CONTEXT);
		await until(first.view, idle);
		first.release();
		await browser.wait(`!${root}.querySelector('.working-frame')`);
		// The rows keep their order. They stay shown across the switch; the main conversation is selected on the session's
		// row, not on its branch's.
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].map(e=>e.textContent+(e.classList.contains('active')?'*':'')).join('|')==='Branches|second' && document.querySelector('.sidebar-section[data-key=recent] .nav-row.selected > .session-main')`,
		);
		assert.equal(await browser.evaluate<boolean>(`${branches}.hidden`), false);
		// Collapsing hides them again.
		await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`${branches}.hidden && ${toggle}.getAttribute('aria-expanded')==='false'`);
		await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`!${branches}.hidden`);
	});

	it("renames a branch: its pencil on hover or focus, Rename branch… in its menu (Cmd+K, a long press)", async () => {
		const rows = () =>
			browser.evaluate<string>(
				`[...document.querySelectorAll('.sidebar-section[data-key=recent] .branch-row')].map(e=>e.textContent).join('|')`,
			);
		const rowOf = (label: string) =>
			`[...document.querySelectorAll('.sidebar-section[data-key=recent] .nav-row:has(> .branch-row)')].find(e=>e.querySelector('.session-title').textContent===${JSON.stringify(label)})`;
		const pencilOf = (label: string) => `${rowOf(label)}.querySelector('.branch-rename')`;
		const shown = (label: string) => `getComputedStyle(${pencilOf(label)}).display !== 'none'`;
		const key = async (event: { key: string; code: string; windowsVirtualKeyCode: number; modifiers?: number }) => {
			await browser.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
			await browser.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
		};
		const mac = await browser.evaluate<boolean>(`/Mac|iPhone|iPad/.test(navigator.platform)`);
		const commandK = () => key({ key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: mac ? 4 : 2 });
		/** The menu open on branch `label`. */
		const menuOn = (label: string) =>
			browser.wait(
				`document.querySelector('.command-menu .command-chip')?.textContent===${JSON.stringify(`Branch · ${label}`)}`,
			);
		/** The rename sheet open on `label`: its field focused, its text selected. */
		const sheetOn = (label: string) =>
			browser.wait(
				`(() => { const e = document.querySelector('.sheet input'); return e?.value===${JSON.stringify(label)} && document.activeElement === e && e.selectionStart === 0 && e.selectionEnd === e.value.length; })()`,
			);
		/** The open menu, on branch `label`, offers Rename branch… in the Branch group: picking it opens the sheet. */
		const renameFromMenu = async (label: string) => {
			await menuOn(label);
			const option = `[...document.querySelectorAll('.command-menu .command-group')].find(g=>g.querySelector('.command-heading')?.textContent==='Branch')?.querySelector('[role=option]')`;
			await browser.wait(`${option}?.querySelector('.command-title')?.textContent==='Rename branch…'`);
			await browser.evaluate(`${option}.click()`);
			await browser.wait(`!document.querySelector('.command-menu')`);
			await sheetOn(label);
		};
		const save = async (text: string) => {
			await browser.evaluate(
				`(()=>{const e=document.querySelector('.sheet input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
			);
			await browser.evaluate(`document.querySelector('.sheet button[type="submit"]').click()`);
			await browser.wait(`!document.querySelector('.sheet')`);
			await browser.wait(`${rowOf(text)}`);
		};
		// The pencil shows on hover, over the row's end: the label and the marker do not move.
		const layout = (label: string) =>
			browser.evaluate<string>(
				`[${rowOf(label)}.querySelector('.nav-link'), ${rowOf(label)}.querySelector('.nav-marker')].map(e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height].join()}).join('|')`,
			);
		assert.equal(await browser.evaluate<boolean>(shown("second")), false);
		const resting = await layout("second");
		const middle = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = ${rowOf("second")}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...middle });
		await browser.wait(shown("second"));
		assert.equal(await layout("second"), resting);
		assert.deepEqual(
			await browser.evaluate<unknown>(
				`(() => { const p = ${pencilOf("second")}, r = p.getBoundingClientRect(), row = ${rowOf("second")}.getBoundingClientRect(); return [p.getAttribute('aria-label'), p.title, r.right <= row.right && r.left >= row.left && r.top >= row.top - 0.5 && r.bottom <= row.bottom + 0.5]; })()`,
			),
			["Rename branch second", "Rename branch", true],
		);
		await browser.click(`.sidebar-section[data-key=recent] .branch-rename[aria-label="Rename branch second"]`);
		await sheetOn("second");
		await save("Second try");
		// A right-click keeps the browser's own menu.
		assert.equal(
			await browser.evaluate<boolean>(
				`${rowOf("Second try")}.querySelector('.branch-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))`,
			),
			true,
		);
		assert.equal(await browser.evaluate<boolean>(`Boolean(document.querySelector('.command-menu'))`), false);
		// A session rename reaches conversation 1's row (a null label shows the session title).
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		await sessions.rename({ id, title: "Renamed" }, BACKGROUND_CONTEXT);
		await browser.wait(`${rowOf("Renamed")}`);
		assert.equal(await rows(), "Renamed|Second try");
		// The keyboard: focus on a row shows its pencil, Tab reaches it, Enter opens the sheet.
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500 });
		await browser.evaluate(`${rowOf("Renamed")}.querySelector('.branch-row').focus()`);
		await browser.wait(shown("Renamed"));
		await key({ key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
		await browser.wait(`document.activeElement === ${pencilOf("Renamed")}`);
		// A key down with its text, as a key press activates a button.
		await browser.call("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			text: "\r",
		});
		await browser.call("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		await sheetOn("Renamed");
		await save("Main line");
		assert.equal(await rows(), "Main line|Second try");
		assert.equal((await row()).branches.find((branch) => branch.conversation === 1)?.label, "Main line");
		// Cmd+K (Ctrl+K) on the focused row: its menu, Rename branch… in the Branch group, also once it was used.
		for (const [from, to] of [
			["Second try", "Second"],
			["Second", "Second try"],
		] as const) {
			await browser.evaluate(`${rowOf(from)}.querySelector('.branch-row').focus()`);
			await commandK();
			await renameFromMenu(from);
			await save(to);
		}
		await browser.evaluate(`${rowOf("Second try")}.querySelector('.branch-row').focus()`);
		await commandK();
		await menuOn("Second try");
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.command-menu .command-group')].filter(g=>g.querySelector('[role=option]')).map(g=>g.querySelector('.command-heading')?.textContent).slice(0, 1)`,
			),
			["Branch"],
		);
		assert.equal(
			await browser.evaluate<boolean>(
				`[...document.querySelectorAll('.command-menu .command-group')].some(g=>g.querySelector('.command-heading')?.textContent==='Recent' && g.textContent.includes('Rename branch…'))`,
			),
			false,
		);
		await key({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await browser.wait(`!document.querySelector('.command-menu')`);
		// A phone, in the drawer: no pencil; a long press on another branch's row (a switch) opens its menu without
		// switching to it; its rename sheet opens over the drawer, which stays open after saving.
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.click(".topbar button[aria-label=Sessions]");
		await browser.wait(`document.querySelector('.app.drawer-open')`);
		const toggle = `document.querySelector('.sidebar-section[data-key=recent] .session-header .subagent-toggle')`;
		await browser.wait(toggle);
		if ((await browser.evaluate<string>(`${toggle}.getAttribute('aria-expanded')`)) === "false")
			await browser.evaluate(`${toggle}.click()`);
		await browser.wait(`${rowOf("Second try")}`);
		await new Promise((resolve) => setTimeout(resolve, 400));
		await browser.evaluate(`${rowOf("Second try")}.querySelector('.branch-row').focus()`);
		assert.equal(await browser.evaluate<boolean>(shown("Second try")), false);
		const before = await browser.evaluate<string>(`location.pathname`);
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = ${rowOf("Second try")}.querySelector('.session-title').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
		await new Promise((resolve) => setTimeout(resolve, 700));
		await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await menuOn("Second try");
		assert.equal(await browser.evaluate<string>(`location.pathname`), before);
		assert.equal((await row()).main, 1);
		await renameFromMenu("Second try");
		assert.equal(await browser.evaluate<boolean>(`Boolean(document.querySelector('.app.drawer-open'))`), true);
		await save("Second, on a phone");
		assert.equal(await browser.evaluate<boolean>(`Boolean(document.querySelector('.app.drawer-open'))`), true);
		// A touch that moves (a scroll, here further than the browser's tap slop) opens nothing.
		const moved = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = ${rowOf("Second, on a phone")}.querySelector('.session-title').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [moved] });
		await browser.call("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x: moved.x + 30, y: moved.y }],
		});
		await new Promise((resolve) => setTimeout(resolve, 700));
		await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await browser.evaluate<boolean>(`Boolean(document.querySelector('.command-menu'))`), false);
		assert.equal((await row()).main, 1);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		await browser.metrics(1280, 900);
		// Back to the session title, from the pencil (the docked sidebar shows the same rows).
		const desktopToggle = `document.querySelector('.sidebar-section[data-key=recent] .session-header .subagent-toggle')`;
		await browser.wait(desktopToggle);
		if ((await browser.evaluate<string>(`${desktopToggle}.getAttribute('aria-expanded')`)) === "false")
			await browser.evaluate(`${desktopToggle}.click()`);
		await browser.wait(`${rowOf("Main line")}`);
		await browser.evaluate(`${rowOf("Main line")}.querySelector('.branch-row').focus()`);
		await browser.wait(shown("Main line"));
		await browser.evaluate(`${pencilOf("Main line")}.click()`);
		await sheetOn("Main line");
		await browser.evaluate(
			`[...document.querySelectorAll('.sheet button')].find(e=>e.textContent==='Use the session title').click()`,
		);
		await browser.wait(`!document.querySelector('.sheet') && ${rowOf("Renamed")}`);
		assert.equal((await row()).branches.find((branch) => branch.conversation === 1)?.label, null);
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

	it("draws the branches as a tree under their source, with guides; the subagents as a list after it", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = (await sessions.create({ cwd: fixture.workspace, title: "Tree" }, BACKGROUND_CONTEXT)).id;
		const agents = await holdIn(owner, Subagents, {}, "reader");
		const tree = await holdIn(owner, SessionTree, { session }, "owner");
		/** Branches after the answer `answer` (a fork of the conversation storing it), labelled `label`. */
		const branchAfter = async (answer: string, label: string) => {
			const nodes = (await tree.tree(BACKGROUND_CONTEXT)).nodes;
			const node = nodes.find((each) => each.role === "assistant" && each.text === answer)!;
			const { conversation } = await tree.navigate({ entry: node.entry }, BACKGROUND_CONTEXT);
			await tree.rename({ conversation, label }, BACKGROUND_CONTEXT);
			return conversation;
		};
		await send(1, "first", session);
		await send(1, "subagent", session);
		await until(agents.children, (value) => value?.[session]?.length === 1);
		await send(1, "second", session);
		// 1 → B and 1 → A (newer, so listed first) → A1; "verify" and "check" spawned in A, "helper" in 1 and then
		// archived.
		// B continues (a branch ending at the fork point would be switched to, not forked again).
		await send(await branchAfter("Echo: first", "B"), "revert it", session);
		const a = await branchAfter("Echo: first", "A");
		await send(a, "use OAuth", session);
		const verify = { action: "spawn", name: "verify", message: "hello verify", tools: ["read"] };
		const inA = await holdIn(owner, Chat, { session, conversation: a }, "participant");
		await inA.send({ text: `subagent ${JSON.stringify(verify)}`, requestId: "verify" }, BACKGROUND_CONTEXT);
		await until(agents.children, (value) => value?.[session]?.length === 2);
		await until(inA.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: hello verify") && idle(view));
		const check = { action: "spawn", name: "check", message: "hello check", tools: ["read"] };
		await inA.send({ text: `subagent ${JSON.stringify(check)}`, requestId: "check" }, BACKGROUND_CONTEXT);
		await until(agents.children, (value) => value?.[session]?.length === 3);
		await until(inA.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: hello check") && idle(view));
		inA.release();
		const a1 = await branchAfter("Echo: use OAuth", "A1");
		await send(a1, "subagent-archive", session);
		await until(agents.children, (value) => Boolean(value?.[session]?.some((child) => child.archived)));
		tree.release();
		const item = `[...document.querySelectorAll('.sidebar-section[data-key=recent] .session-row')].find(e=>e.querySelector('.session-header .session-title').textContent==='Tree')`;
		/** Opens the session (on a phone in the drawer) with its conversations and its archived ones shown. */
		const openTree = async () => {
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${a1}`);
			if (await browser.evaluate<boolean>(`innerWidth < 700`)) {
				await browser.click(".topbar button[aria-label=Sessions]");
				await browser.wait(`document.querySelector('.app.drawer-open')`);
			}
			await browser.wait(`${item}?.querySelector('.subagent-toggle')`);
			const toggle = `${item}.querySelector('.subagent-toggle')`;
			if ((await browser.evaluate<string>(`${toggle}.getAttribute('aria-expanded')`)) === "false")
				await browser.click(".sidebar-section[data-key=recent] .session-header.has-subagents .subagent-toggle");
			await browser.wait(`${item}.querySelector('.subagent-stored')`);
			if (
				(await browser.evaluate<string>(
					`${item}.querySelector('.subagent-stored').getAttribute('aria-expanded')`,
				)) === "false"
			)
				await browser.evaluate(`${item}.querySelector('.subagent-stored').click()`);
			await browser.wait(`${item}.querySelector('.subagent-stored').getAttribute('aria-expanded')==='true'`);
		};
		await browser.metrics(1280, 900);
		await openTree();
		/** Each conversation row: its label, kind, depth and guides (kind and level), as the page lays them out. */
		const rows = () =>
			browser.evaluate<{ name: string; kind: string; depth: string; guides: string }[]>(
				`[...${item}.querySelectorAll('.conversation-row')].map(e=>({ name: e.querySelector('.session-title').textContent, kind: e.querySelector('.branch-row') ? 'branch' : e.querySelector('.subagent-stored') ? 'archived' : 'subagent', depth: getComputedStyle(e).getPropertyValue('--depth'), guides: [...e.querySelectorAll(':scope > .tree-guide')].map(g=>g.dataset.guide+g.style.getPropertyValue('--level')).join(' ') }))`,
			);
		// The branch tree first: conversation 1 (the session title), the newest branch first, a pipe for every ancestor whose
		// siblings follow, a tee or an elbow at the row's own level. Then the subagents, one level below the session,
		// whoever spawned them, without guides; the archived one behind its row.
		assert.deepEqual(await rows(), [
			{ name: "Tree", kind: "branch", depth: "1", guides: "elbow1" },
			{ name: "A", kind: "branch", depth: "2", guides: "tee2" },
			{ name: "A1", kind: "branch", depth: "3", guides: "pipe2 elbow3" },
			{ name: "B", kind: "branch", depth: "2", guides: "elbow2" },
			{ name: "check", kind: "subagent", depth: "1", guides: "" },
			{ name: "verify", kind: "subagent", depth: "1", guides: "" },
			{ name: "1 archived", kind: "archived", depth: "1", guides: "" },
			{ name: "helper", kind: "subagent", depth: "2", guides: "" },
		]);
		// Conversation 1 and A (something forked from them) show the fork icon, the leaves A1 and B the ring.
		assert.deepEqual(
			await browser.evaluate<string[]>(`[...${item}.querySelectorAll('.nav-row:has(> .branch-row)')].map(${GLYPH})`),
			["fork", "fork", "ring", "ring"],
		);
		/** One row's measures, in its inline direction (starts are right edges in RTL); the session row's first. */
		type Measured = {
			name: string;
			/** A branch row (it draws guides) or not, and how many guides it draws. */
			branch: boolean;
			guides: number;
			/** The label's cap-height midline: its baseline (an inline-block probe) less half an "H" in its font (measureText). */
			capMidline: number;
			depth: number;
			/** The row's vertical centre. */
			mid: number;
			/** The marker column's start, centre (x) and size. */
			marker: number;
			markerCentre: number;
			markerSize: number[];
			/** The mark in the column (an icon, a ring, a spinner): its kind, centre and vertical centre. */
			mark: { kind: string; centre: number; mid: number } | null;
			/** The label's line box's vertical centre. */
			label: number;
			/**
			 * Where the label's text starts, and where the mark's ink (an icon's strokes, a ring) starts and ends; a ring's
			 * from its layout width around its centre, as the spinner turns (a turned box's bounds are wider).
			 */
			labelStart: number;
			ink: { start: number; end: number } | null;
			/**
			 * The trunk's centre (x), top and bottom; the twig's top, the arm's end and its line's vertical centre; the
			 * joint (`tee`, `elbow`). NaN and null: none.
			 */
			trunk: number;
			top: number;
			trunkEnd: number;
			twigTop: number;
			arm: number;
			armMid: number;
			joint: string | null;
			/** The twig's corner radius. */
			curve: number;
			/** The bottom of the row above, and the row's own. */
			above: number;
			bottom: number;
			/** The working frame's start (null without one) and the time's end (null without one). */
			frame: number | null;
			time: number | null;
			/** How far a working frame reaches outside a 16px icon (`--working-frame-outset`). */
			outset: number;
		};
		const geometry = () =>
			browser.evaluate<Measured[]>(
				`(() => { const rtl = document.documentElement.dir === 'rtl'; const start = (r) => rtl ? r.right : r.left; const end = (r) => rtl ? r.left : r.right; const mid = (r) => (r.top + r.bottom) / 2; const centre = (r) => (r.left + r.right) / 2; const header = ${item}.querySelector('.session-header'); const rows = [header, ...${item}.querySelectorAll('.conversation-row')]; return rows.map((e, i) => { const box = e.getBoundingClientRect(); const m = e.querySelector('.nav-marker').getBoundingClientRect(); const mark = e.querySelector('.nav-marker > .run-mark, .nav-marker > .nav-icon'); const k = mark?.getBoundingClientRect(); const g = e.querySelector(':scope > .tree-guide:not([data-guide=pipe])'); const j = g?.getBoundingClientRect(); const tw = g ? (() => { const s = getComputedStyle(e.querySelector(':scope > .nav-marker'), '::before'); const moved = parseFloat(s.translate.split(' ')[1]); const top = box.top + e.clientTop + parseFloat(s.top) + parseFloat(s.marginTop) + moved; const x = rtl ? box.right - e.clientLeft - parseFloat(s.right) : box.left + e.clientLeft + parseFloat(s.left); const w = parseFloat(s.width); return { top, end: x + (rtl ? -w : w), mid: top + parseFloat(s.height) - parseFloat(s.borderBlockEndWidth) / 2, curve: parseFloat(s.borderEndStartRadius) }; })() : null; const f = e.querySelector('.nav-marker .working-frame')?.getBoundingClientRect(); const t = e.querySelector('.session-time')?.getBoundingClientRect(); const l = e.querySelector('.session-title'); const above = rows[i - 1]?.getBoundingClientRect(); return { name: l.textContent, branch: Boolean(e.querySelector(':scope > .branch-row')), guides: e.querySelectorAll(':scope > .tree-guide').length, capMidline: (() => { const p = document.createElement('span'); p.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'; l.append(p); const base = p.getBoundingClientRect().bottom; p.remove(); const cs = getComputedStyle(l); const c = document.createElement('canvas').getContext('2d'); c.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; return base - c.measureText('H').actualBoundingBoxAscent / 2; })(), depth: i === 0 ? 0 : Number(getComputedStyle(e).getPropertyValue('--depth')), mid: mid(box), marker: start(m), markerCentre: centre(m), markerSize: [m.width, m.height], mark: k ? { kind: mark.classList.contains('nav-icon') ? 'icon' : mark.dataset.state === 'idle' ? 'ring' : 'spinner', centre: centre(k), mid: mid(k) } : null, label: mid(l.getBoundingClientRect()), labelStart: start(e.querySelector('.nav-label').getBoundingClientRect()), ink: (() => { const svg = e.querySelector('.nav-marker .nav-icon > svg:not(.working-frame)'); if (svg) { const r = svg.getBoundingClientRect(), b = svg.getBBox(), k = r.width / 24, w = parseFloat(getComputedStyle(svg).strokeWidth) / 2; const box = { left: r.left + (b.x - w) * k, right: r.left + (b.x + b.width + w) * k }; return { start: start(box), end: end(box) }; } const ring = e.querySelector('.nav-marker > .run-mark'); if (!ring) return null; const c = ring.getBoundingClientRect(), x = (c.left + c.right) / 2, half = ring.offsetWidth / 2; const box = { left: x - half, right: x + half }; return { start: start(box), end: end(box) }; })(), trunk: j ? centre(j) : NaN, top: j ? j.top : NaN, trunkEnd: j ? j.bottom : NaN, twigTop: tw ? tw.top : NaN, arm: tw ? tw.end : NaN, armMid: tw ? tw.mid : NaN, joint: g ? g.dataset.guide : null, curve: tw ? tw.curve : NaN, above: above ? above.bottom : NaN, bottom: box.bottom, frame: f ? start(f) : null, outset: parseFloat(getComputedStyle(e).getPropertyValue('--working-frame-outset')), time: t ? Math.round(end(t)) : null }; }); })()`,
			);
		const near = (a: number, b: number, within: number) => Math.abs(a - b) < within;
		const checkGeometry = async (sign: 1 | -1) => {
			const [header, ...shown] = await geometry();
			// The first level starts 24px in (under the session row's label), each level after it 22px further (a marker box
			// and its 6px gap to the label).
			const inset = (depth: number) => (depth === 0 ? 0 : 24 + (depth - 1) * 22);
			/** Each depth's label start: icon rows and ring rows start their labels in one column. */
			const labels = new Map<number, number>();
			// The working branch's frame reaches this far outside its marker; every arm ends before it would start.
			const outset = header!.outset;
			assert(outset > 0, "the working frame reaches outside the marker");
			// Each depth's marks share one vertical axis (x), the session row's is depth 0.
			const axis = new Map([[0, header!.markerCentre]]);
			for (const row of shown) {
				const { name, depth } = row;
				assert(near(sign * (row.marker - header!.marker), inset(depth), 0.5), `${name} is ${inset(depth)}px in`);
				if (labels.has(depth))
					assert(near(row.labelStart, labels.get(depth)!, 0.5), `${name}'s label is in its depth's column`);
				else labels.set(depth, row.labelStart);
				assert.deepEqual(row.markerSize, [16, 16], `${name}'s marker is one 16px box`);
				if (row.mark) {
					assert(
						near(row.mark.centre, row.markerCentre, 0.5),
						`${name}'s ${row.mark.kind} is centred in its column`,
					);
					assert(
						near(row.mark.mid, row.capMidline, 0.25),
						`${name}'s ${row.mark.kind} is ${row.mark.mid - row.capMidline}px off the cap-height midline`,
					);
				}
				const x = row.mark?.centre ?? row.markerCentre;
				if (axis.has(depth)) assert(near(x, axis.get(depth)!, 0.5), `${name}'s mark is on depth ${depth}'s axis`);
				else axis.set(depth, x);
				assert(near(row.label, row.mid, 1), `${name}'s label is centred on the row`);
				// One visible gap from every mark to its label, an icon's or a ring's: --s2 (8px).
				if (row.ink)
					assert(near(sign * (row.labelStart - row.ink.end), 8, 0.5), `${name}'s mark is 8px from its label`);
				if (!row.branch) {
					// Subagents are a list: no guides.
					assert.equal(row.guides, 0, `${name} draws no guides`);
					if (row.time !== null) assert.equal(row.time, header!.time, `${name}'s time is in the session's column`);
					continue;
				}
				// The trunk runs through the parent's marker centre (a fork's icon).
				assert(near(row.trunk, axis.get(depth - 1)!, 0.5), `${name}'s trunk runs through its parent's marker`);
				// A nested branch's marker starts right under its parent's label (its parent is a fork, an icon row).
				if (depth > 1) {
					const parent = shown
						.slice(0, shown.indexOf(row))
						.findLast((each) => each.branch && each.depth === depth - 1)!;
					assert.equal(parent.mark?.kind, "icon", `${name}'s parent is a fork`);
					assert(near(row.marker, parent.labelStart, 0.5), `${name}'s marker is under its parent's label`);
				}
				// Every arm ends as far from its mark's ink, an icon's or a ring's: --s1 and an icon's inset (6px).
				if (row.ink)
					assert(near(sign * (row.ink.start - row.arm), 6, 0.5), `${name}'s arm ends 6px before its mark`);
				assert(
					near(row.armMid, row.mark?.mid ?? row.mid, 0.25),
					`${name}'s arm is ${row.armMid - (row.mark?.mid ?? row.mid)}px off its mark's centre`,
				);
				assert(near(row.top, row.above, 1), `${name}'s guide reaches the row above`);
				// One unbroken line: the twig starts on the trunk, which a tee runs on to the row's bottom and an elbow
				// ends at or above where the twig's curve starts.
				assert(row.twigTop <= row.trunkEnd + 0.01, `${name}'s twig starts on its trunk`);
				if (row.joint === "tee")
					assert(near(row.trunkEnd, row.bottom, 0.5), `${name}'s tee runs to the row's bottom`);
				else assert(row.trunkEnd <= row.armMid - row.curve + 0.1, `${name}'s trunk ends before its twig's curve`);
				// Its arm ends clear of a working frame, framed or not.
				assert(sign * (row.marker - sign * outset - row.arm) > 0.99, `${name}'s arm ends 1px before a frame`);
				if (row.frame !== null)
					assert(sign * (row.frame - row.arm) > 0.99, `${name}'s arm ends 1px before its frame`);
				// Indenting moves the start only: a time ends where the session's does.
				if (row.time !== null) assert.equal(row.time, header!.time, `${name}'s time is in the session's column`);
			}
			// A ring, a spinner and an icon at one depth: the axis check above held for all three.
			const kinds = new Set(shown.filter((row) => row.depth === 1).map((row) => row.mark?.kind ?? "none"));
			assert.deepEqual([...kinds].sort(), ["icon", "none", "ring", "spinner"]);
		};
		/** Each row's end text sits on its label's baseline (within half a pixel): session, branch and subagent rows. */
		const checkBaselines = async (kinds: readonly string[]) => {
			const offsets = await browser.evaluate<BaselineOffset[]>(
				baselineOffsets(
					`[${item}.querySelector('.session-header'), ...${item}.querySelectorAll('.conversation-row')]`,
				),
			);
			for (const { label, end, offset } of offsets)
				assert(Math.abs(offset) < 0.5, `${label}'s "${end}" is ${offset}px off its baseline`);
			assert.deepEqual([...new Set(offsets.map((each) => each.kind))].sort(), [...kinds].sort());
			// Every row of the sidebar (sessions, conversations, groups, rollups) keeps the row height (28px).
			const heights = await browser.evaluate<number[]>(
				`[...document.querySelectorAll('.sidebar-root .nav-row')].map(e=>e.getBoundingClientRect().height).filter(h=>h>0)`,
			);
			for (const height of heights) assert(Math.abs(height - 28) < 0.5, `a row is ${height}px tall`);
		};
		// While a branch and verify work: the branch's end says what it does, verify's ring is the spinner.
		const verifyId = (await until(agents.children, (v) => Boolean(v?.[session]?.some((c) => c.name === "verify"))))[
			session
		]!.find((child) => child.name === "verify")!.conversationId;
		const selector = await holdIn(owner, SessionTree, { session }, "owner");
		const spinning = await holdIn(owner, Chat, { session, conversation: verifyId }, "participant");
		const rowNamed = (label: string) =>
			`[...${item}.querySelectorAll('.conversation-row')].find(e=>e.querySelector('.session-title').textContent===${JSON.stringify(label)})`;
		const verifyRow = rowNamed("verify");
		let runs = 0;
		/**
		 * Makes branch `label` (`conversation`) the main one and has it and verify work, then measures the tree left to
		 * right and right to left (the drawer supports RTL). `kind`: what its row is (a fork: `branch icon`, framed; a
		 * leaf: `branch ring`, the spinner).
		 */
		const measureWorking = async (label: string, conversation: number, kind: "branch icon" | "branch ring") => {
			runs++;
			await selector.select({ conversation }, BACKGROUND_CONTEXT);
			const working = await holdIn(owner, Chat, { session, conversation }, "participant");
			await working.send({ text: `slow branch ${runs}`, requestId: `slow-branch-${runs}` }, BACKGROUND_CONTEXT);
			await spinning.send({ text: `slow spinner ${runs}`, requestId: `slow-spinner-${runs}` }, BACKGROUND_CONTEXT);
			const mark = kind === "branch icon" ? ".working-frame" : ".run-mark[data-state=working]";
			await browser.wait(
				`${rowNamed(label)}?.querySelector('.nav-marker ${mark}') && ${rowNamed(label)}.querySelector('.subagent-step') && ${verifyRow}?.querySelector('.nav-marker .run-mark[data-state=working]')`,
			);
			for (const sign of [1, -1] as const) {
				await browser.evaluate(`document.documentElement.dir=${JSON.stringify(sign === 1 ? "ltr" : "rtl")}`);
				await checkGeometry(sign);
				await checkBaselines(["session", kind, "subagent"]);
			}
			await browser.evaluate(`document.documentElement.removeAttribute('dir')`);
			await working.stop(BACKGROUND_CONTEXT);
			await spinning.stop(BACKGROUND_CONTEXT);
			await browser.wait(
				`!${rowNamed(label)}.querySelector('${mark}') && !${verifyRow}.querySelector('.run-mark[data-state=working]')`,
			);
			working.release();
		};
		/** Measures with a fork (A) working, then a leaf (A1), which stays the main one. */
		const measureBoth = async () => {
			await measureWorking("A", a, "branch icon");
			await measureWorking("A1", a1, "branch ring");
		};
		await measureBoth();
		// The guides are in --line; with forced colours, in CanvasText.
		const lineColour = `(() => { const g = ${item}.querySelector('.tree-guide[data-guide=elbow]'); const twig = getComputedStyle(g.parentElement.querySelector(':scope > .nav-marker'), '::before').borderBlockEndColor; return getComputedStyle(g).borderInlineStartColor === twig ? twig : 'differ'; })()`;
		const line = await browser.evaluate<string>(
			`(() => { const e = document.createElement('i'); e.style.color = 'var(--line)'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`,
		);
		assert.equal(await browser.evaluate<string>(lineColour), line);
		// Each twig curves into its arm with p2's corner radius (--radius, 4px).
		assert.equal(
			await browser.evaluate<boolean>(
				`[...${item}.querySelectorAll('.tree-guide:not([data-guide=pipe])')].every(g=>getComputedStyle(g.parentElement.querySelector(':scope > .nav-marker'), '::before').borderEndStartRadius === getComputedStyle(document.documentElement).getPropertyValue('--radius').trim())`,
			),
			true,
		);
		// With forced colours a working spinner keeps a clear quarter; the idle ring is whole.
		await spinning.send({ text: "slow forced", requestId: "slow-forced" }, BACKGROUND_CONTEXT);
		await browser.wait(`${verifyRow}?.querySelector('.nav-marker .run-mark[data-state=working]')`);
		await browser.call("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
		const text = await browser.evaluate<string>(
			`(() => { const e = document.createElement('i'); e.style.color = 'CanvasText'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`,
		);
		await browser.wait(`${lineColour} === ${JSON.stringify(text)}`);
		const sides = (mark: string) =>
			`(() => { const s = getComputedStyle(${mark}); return [s.borderBlockStartColor, s.borderInlineEndColor, s.borderBlockEndColor, s.borderInlineStartColor]; })()`;
		const clear = "rgba(0, 0, 0, 0)";
		assert.deepEqual(
			await browser.evaluate<string[]>(sides(`${verifyRow}.querySelector('.run-mark[data-state=working]')`)),
			[text, text, text, clear],
		);
		const ring = await browser.evaluate<string[]>(
			sides(`${rowNamed("check")}.querySelector('.run-mark[data-state=idle]')`),
		);
		assert(!ring.includes(clear) && new Set(ring).size === 1, `the idle ring is whole: ${ring}`);
		await browser.call("Emulation.setEmulatedMedia", { features: [] });
		await spinning.stop(BACKGROUND_CONTEXT);
		await browser.wait(`!${verifyRow}.querySelector('.run-mark[data-state=working]')`);
		// Kinds keep their marks: a branch its icon in the marker column, an idle subagent a ring; the archived row none.
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...${item}.querySelectorAll('.conversation-row')].map(e=>e.querySelector('.nav-marker .nav-icon svg') ? 'icon' : e.querySelector('.nav-marker .run-mark[data-state=idle]') ? 'ring' : '')`,
			),
			["icon", "icon", "ring", "ring", "ring", "ring", "", "ring"],
		);
		// The same on a phone with touch, in the drawer.
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await openTree();
		await measureBoth();
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		spinning.release();
		selector.release();
		// The rows still act: a branch row switches the session there.
		await browser.evaluate(`[...${item}.querySelectorAll('.branch-row')].find(e=>e.textContent==='B').click()`);
		await until(sessions.sessions, (list) => list?.find((each) => each.id === session)?.main !== a1);
		sessions.release();
		agents.release();
	});

	it("cuts long labels with an ellipsis on one line down to their minimum; the end keeps its width and column", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const title = "A session title long enough to be cut at every sidebar width";
		const session = (await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
		const agents = await holdIn(owner, Subagents, {}, "reader");
		const tree = await holdIn(owner, SessionTree, { session }, "owner");
		await send(1, "first", session);
		// Conversation 1 goes on, so a branch after "Echo: first" is a fork (not conversation 1 itself).
		await send(1, "second", session);
		await tree.rename(
			{ conversation: 1, label: "Conversation one, with a label long enough to be cut" },
			BACKGROUND_CONTEXT,
		);
		const fork = async (answer: string, label: string) => {
			const node = (await tree.tree(BACKGROUND_CONTEXT)).nodes.find((each) => each.text === answer)!;
			const { conversation } = await tree.navigate({ entry: node.entry }, BACKGROUND_CONTEXT);
			await tree.rename({ conversation, label }, BACKGROUND_CONTEXT);
			return conversation;
		};
		const a = await fork("Echo: first", "A branch label long enough to be cut at depth two");
		await send(a, "deeper", session);
		const name = "a-subagent-named-long-enough-to-be-cut-at-depth-three";
		const spawn = { action: "spawn", name, message: "hello long", tools: ["read"] };
		const inA = await holdIn(owner, Chat, { session, conversation: a }, "participant");
		await inA.send({ text: `subagent ${JSON.stringify(spawn)}`, requestId: "long-spawn" }, BACKGROUND_CONTEXT);
		const child = (await until(agents.children, (v) => Boolean(v?.[session]?.length)))[session]![0]!;
		await until(inA.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: hello long") && idle(view));
		inA.release();
		const a1 = await fork("Echo: deeper", "A nested branch label long enough to be cut at depth three");
		tree.release();
		const item = `[...document.querySelectorAll('.sidebar-section[data-key=recent] .session-row')].find(e=>e.querySelector('.session-header .session-title').textContent===${JSON.stringify(title)})`;
		const branch = await holdIn(owner, Chat, { session, conversation: a1 }, "participant");
		const subagent = await holdIn(owner, Chat, { session, conversation: child.conversationId }, "participant");
		let runs = 0;
		/** While the nested branch runs a script (its step "Running script") and the subagent thinks, checks the rows. */
		const check = async (phone: boolean) => {
			runs++;
			await branch.send(
				{
					text: `codemode return await tools.agent({ prompt: "slow agent", label: "Slow", schema: { type: "object" } });`,
					requestId: `long-script-${runs}`,
				},
				BACKGROUND_CONTEXT,
			);
			await subagent.send({ text: `slow long ${runs}`, requestId: `long-slow-${runs}` }, BACKGROUND_CONTEXT);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${a1}`);
			if (phone) {
				await browser.click(".topbar button[aria-label=Sessions]");
				await browser.wait(`document.querySelector('.app.drawer-open')`);
			}
			await browser.wait(`${item}?.querySelector('.subagent-toggle')`);
			if (
				(await browser.evaluate<string>(
					`${item}.querySelector('.subagent-toggle').getAttribute('aria-expanded')`,
				)) === "false"
			)
				await browser.evaluate(`${item}.querySelector('.subagent-toggle').click()`);
			const step = (label: string) =>
				`[...${item}.querySelectorAll('.conversation-row')].find(e=>e.querySelector('.session-title').textContent===${JSON.stringify(label)})?.querySelector('.subagent-step')`;
			await browser.wait(
				`${step("A nested branch label long enough to be cut at depth three")}?.textContent==='Running script' && ${step(name)}?.textContent==='Thinking'`,
			);
			// Each row: its label's overflow and style, the label's box and minimum, its marker, arm and details, and its
			// step's overflow (left to right).
			const rows = await browser.evaluate<
				{
					name: string;
					cut: boolean;
					textOverflow: string;
					whiteSpace: string;
					lines: number;
					labelStart: number;
					labelEnd: number;
					labelWidth: number;
					labelMin: number;
					markerEnd: number;
					markerStart: number;
					arm: number | null;
					detailsStart: number | null;
					detailsEnd: number | null;
					rowEnd: number;
					step: { cut: boolean; textOverflow: string } | null;
				}[]
			>(
				`[${item}.querySelector('.session-header'), ...${item}.querySelectorAll('.conversation-row')].map(e => { const l = e.querySelector('.nav-label'); const link = e.querySelector('.nav-link').getBoundingClientRect(); const cs = getComputedStyle(l); const m = e.querySelector('.nav-marker').getBoundingClientRect(); const g = e.querySelector(':scope > .tree-guide:not([data-guide=pipe])') ? getComputedStyle(e.querySelector(':scope > .nav-marker'), '::before') : null; const d = e.querySelector('.nav-details')?.getBoundingClientRect(); const s = e.querySelector('.subagent-step'); const row = e.getBoundingClientRect(); return { name: e.querySelector('.session-title').textContent, cut: l.scrollWidth > l.clientWidth, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace, lines: Math.round(l.getBoundingClientRect().height / parseFloat(cs.lineHeight)), labelStart: link.left, labelEnd: link.right, labelWidth: link.width, labelMin: 4 * parseFloat(getComputedStyle(e.querySelector('.nav-link')).fontSize), markerStart: m.left, markerEnd: m.right, arm: g ? row.left + e.clientLeft + parseFloat(g.left) + parseFloat(g.width) : null, detailsStart: d ? d.left : null, detailsEnd: d ? d.right : null, rowEnd: row.right - parseFloat(getComputedStyle(e).paddingInlineEnd), step: s && { cut: s.scrollWidth > s.clientWidth, textOverflow: getComputedStyle(s).textOverflow } }; })`,
			);
			const [header, ...shown] = rows;
			const where = phone ? "phone" : "desktop";
			for (const row of rows) {
				const what = `${row.name} (${where})`;
				// One line, cut with "…".
				assert.equal(row.lines, 1, `${what} is one line`);
				assert.deepEqual(
					[row.textOverflow, row.whiteSpace],
					["ellipsis", "nowrap"],
					`${what} is cut with an ellipsis`,
				);
				// Nothing overlaps: the arm ends before the marker, the label after it, the details after the label.
				if (row.arm !== null) assert(row.arm < row.markerStart, `${what}: the arm ends before the marker`);
				assert(row.labelStart >= row.markerEnd, `${what}: the label starts after the marker`);
				if (row.detailsStart !== null)
					assert(row.detailsStart >= row.labelEnd, `${what}: the details follow the label`);
				// The end keeps its column: the details end where the session's time does.
				if (row.detailsEnd !== null)
					assert(
						Math.abs(row.detailsEnd - header!.detailsEnd!) < 0.5,
						`${what}: the details end in the time column`,
					);
			}
			// The long labels are cut, and a conversation's label keeps its minimum width beside a step.
			for (const label of [
				title,
				"Conversation one, with a label long enough to be cut",
				"A branch label long enough to be cut at depth two",
				"A nested branch label long enough to be cut at depth three",
				name,
			])
				assert(rows.find((row) => row.name === label)?.cut, `${label} is cut (${where})`);
			for (const row of shown)
				assert(row.labelWidth >= row.labelMin - 0.5, `${row.name}'s label keeps its minimum width (${where})`);
			// The end (a step) is a word or two: never cut, its whole text shown; the label gives way instead.
			for (const row of shown)
				if (row.step) assert.equal(row.step.cut, false, `${row.name}'s step is whole (${where})`);
			assert(
				shown.find((row) => row.name.startsWith("A nested"))?.step,
				`the nested branch shows its step (${where})`,
			);
			await branch.stop(BACKGROUND_CONTEXT);
			await subagent.stop(BACKGROUND_CONTEXT);
			await until(branch.view, idle);
			await until(subagent.view, idle);
		};
		await browser.metrics(1280, 900);
		await check(false);
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await check(true);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		await browser.metrics(1280, 900);
		branch.release();
		subagent.release();
		sessions.release();
		agents.release();
	});

	it("keeps a deep chain of forks inside a phone's sidebar: deeper rows stay at the deepest level's place", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = (await sessions.create({ cwd: fixture.workspace, title: "Deep" }, BACKGROUND_CONTEXT)).id;
		const tree = await holdIn(owner, SessionTree, { session }, "owner");
		await send(1, "first", session);
		await send(1, "second", session);
		// Each level forks after the previous level's first answer (its branch goes on past it, so it is a fork).
		let from = "Echo: first";
		let deepest = 1;
		for (let level = 1; level <= 7; level++) {
			const node = (await tree.tree(BACKGROUND_CONTEXT)).nodes.find((each) => each.text === from)!;
			deepest = (await tree.navigate({ entry: node.entry }, BACKGROUND_CONTEXT)).conversation;
			await tree.rename({ conversation: deepest, label: `level ${level}` }, BACKGROUND_CONTEXT);
			await send(deepest, `step ${level}`, session);
			await send(deepest, `more ${level}`, session);
			from = `Echo: step ${level}`;
		}
		tree.release();
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}/c/${deepest}`);
		await browser.click(".topbar button[aria-label=Sessions]");
		await browser.wait(`document.querySelector('.app.drawer-open')`);
		const item = `[...document.querySelectorAll('.sidebar-section[data-key=recent] .session-row')].find(e=>e.querySelector('.session-header .session-title').textContent==='Deep')`;
		await browser.wait(`${item}?.querySelector('.subagent-toggle')`);
		if (
			(await browser.evaluate<string>(`${item}.querySelector('.subagent-toggle').getAttribute('aria-expanded')`)) ===
			"false"
		)
			await browser.evaluate(`${item}.querySelector('.subagent-toggle').click()`);
		// The deepest level works: its end shows its step.
		const working = await holdIn(owner, Chat, { session, conversation: deepest }, "participant");
		await working.send({ text: "slow deep", requestId: "slow-deep" }, BACKGROUND_CONTEXT);
		await browser.wait(
			`[...${item}.querySelectorAll('.conversation-row .subagent-step')].some(e=>e.textContent==='Thinking')`,
		);
		const rows = await browser.evaluate<
			{
				name: string;
				depth: number;
				marker: number;
				overflow: number;
				detailsEnd: number | null;
				end: number;
				label: number;
				labelMin: number;
			}[]
		>(
			`[...${item}.querySelectorAll('.conversation-row')].map(e => { const d = e.querySelector('.nav-details')?.getBoundingClientRect(); const r = e.getBoundingClientRect(); return { name: e.querySelector('.session-title').textContent, depth: Number(getComputedStyle(e).getPropertyValue('--depth')), marker: e.querySelector('.nav-marker').getBoundingClientRect().left, overflow: e.scrollWidth - e.clientWidth, detailsEnd: d ? d.right : null, end: r.right - parseFloat(getComputedStyle(e).paddingInlineEnd), label: e.querySelector('.nav-link').getBoundingClientRect().width, labelMin: 4 * parseFloat(getComputedStyle(e.querySelector('.nav-link')).fontSize) }; })`,
		);
		assert.deepEqual(
			rows.map((row) => row.depth),
			[1, 2, 3, 4, 5, 6, 7, 8],
		);
		const fifth = rows.find((row) => row.depth === 5)!;
		for (const row of rows) {
			assert(row.overflow <= 0, `${row.name} overflows by ${row.overflow}px`);
			if (row.detailsEnd !== null) assert(row.detailsEnd <= row.end + 0.5, `${row.name}'s end is inside its row`);
			assert(row.label >= row.labelMin - 0.5, `${row.name}'s label keeps its minimum width`);
			if (row.depth > 5) assert.equal(row.marker, fifth.marker, `${row.name} stays at the fifth level's place`);
		}
		assert(rows.at(-1)!.detailsEnd !== null, "the deepest row shows its step");
		await working.stop(BACKGROUND_CONTEXT);
		await until(working.view, idle);
		working.release();
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		await browser.metrics(1280, 900);
		sessions.release();
	});
});
