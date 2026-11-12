// Archived/search, artifacts (the list, views, in place), file viewers and cost charts use only disposable fake-provider
// sessions.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Artifacts } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Search } from "../../plugins/search/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Views } from "../../plugins/views/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const input = (selector: string, value: string) =>
	`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
describe("search, viewers, artifacts and cost parity", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, id: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "created.txt"), "A private test snapshot, not configuration.\n");
		id = (
			await (
				await holdIn(fixture.browser(), Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Viewer fixture" }, BACKGROUND_CONTEXT)
		).id;
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	it("searches titles and messages, switches archive scope, and restores an archived message hit", async () => {
		const owner = fixture.browser(),
			sessions = await holdIn(owner, Sessions, {}, "owner"),
			search = owner.hold(Search, {}, BACKGROUND_CONTEXT);
		const session = await sessions.create({ cwd: fixture.workspace, title: "Search fixture" }, BACKGROUND_CONTEXT),
			chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "Unique search needle", requestId: "needle" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.entries).includes("Echo: Unique search needle"));
		await browser.metrics(1280, 900);
		// Recents' list page searches its sessions' titles and messages.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/list/recent`);
		await browser.wait(
			`document.querySelector('.list-page input[aria-label="Search sessions and messages"]')&&!document.querySelector('.offline')`,
		);
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', "Search fixture"));
		await browser.wait(
			`[...document.querySelectorAll('.list-page .session-title')].map(e=>e.textContent).join()==='Search fixture'`,
		);
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', "Unique search needle"));
		await browser.wait(`document.querySelector('.list-page .hit')?.textContent.includes('Unique search needle')`);
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		// Refresh the submitted query, as mobile does on an edit: the archived session is no longer in Recents.
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', "Unique search needle "));
		await browser.wait(`!document.querySelector('.list-page .hit')`);
		// The Archive's list page searches the archive.
		await browser.click(".sidebar-section[data-key=archive] .group-label");
		await browser.wait(`location.pathname==='/list/archive' && document.querySelector('.list-page input')`);
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', "Unique search needle"));
		await browser.wait(`document.querySelector('.list-page .hit')?.textContent.includes('Unique search needle')`);
		assert(
			(await search.search({ query: "Unique search needle", archived: true }, BACKGROUND_CONTEXT)).messages.length >
				0,
		);
		await browser.click(".list-page .hit");
		await browser.wait(`location.pathname==='/s/${session.id}'`);
		await until(sessions.sessions, (rows) => rows?.find((row) => row.id === session.id)?.archivedAt === null);
	});
	it("lists the session's artifacts, opens one as a view only on a click", async () => {
		const owner = fixture.browser(),
			chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant"),
			list = await holdIn(owner, Artifacts, { session: id }, "editor");
		for (let version = 1; version <= 2; version++) {
			await chat.send({ text: "artifact", requestId: `v-${version}` }, BACKGROUND_CONTEXT);
			await until(list.artifacts, (artifacts) => artifacts?.[0]?.version === version);
			await until(chat.view, (view) => !(view?.docs["pi.live"] as { run?: unknown })?.run);
		}
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('button[aria-label="Artifacts (1)"]')`);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.views-pane.kind-html').length`), 0);
		await browser.click('button[aria-label="Artifacts (1)"]');
		await browser.wait(`document.querySelectorAll('.artifact-row').length===1`);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('.artifact-row').textContent`),
			/Demo artifact/,
		);
		await browser.click(".artifact-row");
		await browser.wait(
			`document.querySelector('.views-pane.kind-html iframe') && !document.querySelector('[data-testid=artifact-panel]')`,
		);
		assert.equal(
			await browser.evaluate<string>(
				`document.querySelector('.views-pane.kind-html iframe').getAttribute('sandbox')`,
			),
			"allow-scripts allow-modals allow-pointer-lock",
		);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('.views-pane.kind-html iframe').getAttribute('src')`),
			/id=demo&version=2/,
		);
		// The later cases work beside the bare chat.
		const views = await holdIn(owner, Views, { session: id }, "editor");
		for (const view of views.views.value) await views.close({ id: view.id }, BACKGROUND_CONTEXT);
		await browser.wait(`!document.querySelector('.views-pane.kind-html')`);
		views.release();
		await browser.evaluate("localStorage.clear()");
	});
	it("shows an artifact the agent showed in place in the transcript, its page mounted once on screen", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		// Both calls showed it, each card the newest version; a card's page mounts once it is (nearly) on screen.
		const cards = `[...document.querySelectorAll('.artifact-inline[data-artifact=demo]')]`;
		await browser.wait(`${cards}.length === 2 && ${cards}.at(-1).querySelector('iframe.artifact-frame')`);
		assert.match(
			await browser.evaluate<string>(`${cards}.at(-1).querySelector('iframe').getAttribute('src')`),
			/id=demo&version=2/,
		);
		await browser.evaluate(`${cards}[0].scrollIntoView()`);
		await browser.wait(`${cards}[0].querySelector('iframe.artifact-frame')`);
	});
	it("docks the artifact list on the right on wide screens and toggles it from the top bar", async () => {
		const button = 'button[aria-label="Artifacts (1)"]';
		const docked = "document.querySelectorAll('#side-dock [data-testid=artifact-panel] .artifact-row').length===1";
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('${button}')`);
		// The session opens with the panels it last had (src/web/session-panels.ts); an earlier test left the list open.
		if ((await browser.evaluate<string>(`document.querySelector('${button}').ariaPressed`)) === "true") {
			await browser.click(button);
			await browser.wait(`document.querySelector('${button}').ariaPressed === "false"`);
		}
		await browser.click(button);
		await browser.wait(docked);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.sheet-layer').length`), 0);
		assert.equal(await browser.evaluate<string>(`document.querySelector('${button}').ariaPressed`), "true");
		// Its left edge drags to resize it; the width is kept for every side panel.
		await browser.evaluate("localStorage.removeItem('p2-side-panel-width')");
		const width = () =>
			browser.evaluate<number>("document.querySelector('#side-dock .side-panel').getBoundingClientRect().width");
		assert.equal(await width(), 460);
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(()=>{const r=document.querySelector('.side-panel-resize').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
		const to = { x: point.x - 100, y: point.y };
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...to, button: "left", buttons: 1 });
		await browser.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 });
		// The pointer sets the edge: about 100px wider, as grabbed within the 6px handle.
		await browser.wait(`Math.abs(Number(localStorage.getItem('p2-side-panel-width'))-560)<=3`);
		const dragged = await width();
		assert.equal(String(dragged), await browser.evaluate<string>("localStorage.getItem('p2-side-panel-width')"));
		await browser.click(button);
		await browser.wait("!document.querySelector('#side-dock [data-testid=artifact-panel]')");
		await browser.click(button);
		await browser.wait(docked);
		// One thing at a time: a run's activity replaces the list, the list replaces the activity.
		// The newest run's (the earlier ones sit above the pages shown in place, out of view).
		await browser.evaluate(
			`(() => { const a = [...document.querySelectorAll('[data-testid=activity]')].at(-1); a.scrollIntoView({ block: 'center' }); a.querySelector('button').click(); })()`,
		);
		await browser.wait(
			"document.querySelector('#side-dock .activity-panel') && !document.querySelector('[data-testid=artifact-panel]')",
		);
		assert.equal(await width(), dragged);
		await browser.click(button);
		await browser.wait(`${docked} && !document.querySelector('.activity-panel')`);
		await browser.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
		await browser.wait("!document.querySelector('#side-dock [data-testid=artifact-panel]')");
		await browser.evaluate("localStorage.removeItem('p2-side-panel-width')");
	});
	it("opens a sent-file card as a conservative viewer and explicitly downloads the same snapshot", async () => {
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		await chat.send({ text: "send-file", requestId: "snapshot" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.entries).includes("created.txt"));
		await browser.wait(`document.querySelector('a[aria-label="Open created.txt"]')`);
		await browser.click('a[aria-label="Open created.txt"]');
		await browser.wait(`document.querySelector('.viewer-content')?.textContent.includes('A private test snapshot')`);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.viewer-content iframe').length`), 0);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('.viewer-head a').getAttribute('download')`),
			"created.txt",
		);
		const directory = join(fixture.workspace, "browser-downloads");
		mkdirSync(directory);
		await browser.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
		await browser.click(".viewer-head a");
		await poll(() => existsSync(join(directory, "created.txt")), 5000, "explicit file download");
		assert.equal(
			readFileSync(join(directory, "created.txt"), "utf8"),
			"A private test snapshot, not configuration.\n",
		);
		await browser.click('button[aria-label="Close viewer"]');
	});
	it("selects a cost chart column and its corresponding table row, and closes with Escape", async () => {
		await browser.wait(`document.querySelector('.cost-link')`);
		await browser.click(".cost-link");
		await browser.wait(`document.querySelectorAll('.cost-column').length>=3`);
		await browser.evaluate(`document.querySelectorAll('.cost-column')[1].classList.add('test-cost-column')`);
		await browser.click(".test-cost-column");
		await browser.wait(`document.querySelectorAll('.cost-table tbody tr')[1]?.classList.contains('selected')`);
		await browser.call("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
		});
		await browser.call("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
		});
		await browser.wait(`!document.querySelector('[role=dialog][aria-label=Cost]')`);
	});
});
