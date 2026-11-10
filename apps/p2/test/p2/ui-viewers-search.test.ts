// Archived/search, explicit versioned previews and cost charts use only disposable fake-provider sessions.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ArtifactList } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Search } from "../../plugins/search/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
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
	it("lists every immutable artifact version newest first, opens only on a click and returns with Back", async () => {
		const owner = fixture.browser(),
			chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant"),
			list = owner.hold(ArtifactList, { session: id, conversation: 1 }, BACKGROUND_CONTEXT);
		for (let version = 1; version <= 2; version++) {
			await chat.send({ text: "artifact", requestId: `v-${version}` }, BACKGROUND_CONTEXT);
			await until(list.artifacts, (artifacts) => artifacts?.length === version);
			await until(chat.view, (view) => !(view?.docs["pi.live"] as { run?: unknown })?.run);
		}
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('button[aria-label="Artifacts (2)"]')`);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.viewer-panel').length`), 0);
		await browser.click('button[aria-label="Artifacts (2)"]');
		await browser.wait(`document.querySelectorAll('.artifact-row').length===2`);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.artifact-row>small')].map(e=>e.textContent)`,
			),
			["html · v2", "html · v1"],
		);
		await browser.click(".artifact-row");
		await browser.wait(
			`document.querySelector('.viewer-panel iframe') && document.querySelector('.artifact-diagnostics')`,
		);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('.viewer-panel iframe').getAttribute('sandbox')`),
			"allow-scripts allow-modals allow-pointer-lock",
		);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('.viewer-head').textContent`),
			/html · version 2/,
		);
		await browser.evaluate(
			`window.dispatchEvent(new MessageEvent('message',{source:window,data:{channel:'p2-artifact-diagnostic',level:'error',message:'Wrong frame'}}))`,
		);
		assert.equal(
			await browser.evaluate<boolean>(
				`document.querySelector('.artifact-diagnostics').textContent.includes('Wrong frame')`,
			),
			false,
		);
		await browser.evaluate("history.back()");
		await browser.wait(
			`document.querySelectorAll('.artifact-row').length===2 && !document.querySelector('.viewer-panel')`,
		);
		await browser.click("[role=dialog] button[aria-label=Close]");
	});
	it("links artifacts to their viewer: a modified click is the browser's, the link address opens the viewer", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('a[aria-label="Open Demo artifact"]')`);
		const card = await browser.evaluate<string>(
			`document.querySelector('a[aria-label="Open Demo artifact"]').getAttribute('href')`,
		);
		assert(card.startsWith(`/s/${id}?viewer=artifacts&at=`), card);
		await browser.click('button[aria-label="Artifacts (2)"]');
		await browser.wait(`document.querySelectorAll('a.artifact-row').length===2`);
		const row = await browser.evaluate<string>(`document.querySelector('a.artifact-row').getAttribute('href')`);
		assert(row.startsWith(`/s/${id}?viewer=artifacts&at=`), row);
		// Cmd (macOS), Ctrl, Shift or the middle button: the browser opens the link elsewhere; this page stays.
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(()=>{const r=document.querySelector('a.artifact-row').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
		for (const [button, modifiers] of [
			["left", process.platform === "darwin" ? 4 : 2],
			["left", 8],
			["middle", 0],
		] as const) {
			await browser.call("Input.dispatchMouseEvent", {
				type: "mousePressed",
				...point,
				button,
				modifiers,
				clickCount: 1,
			});
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				...point,
				button,
				modifiers,
				clickCount: 1,
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.viewer-panel').length`), 0);
		assert.equal(await browser.evaluate<string>("location.pathname+location.search"), `/s/${id}`);
		// A new tab at the row's address opens that version's viewer over the conversation; the address bar shows the
		// conversation, and closing the viewer stays there.
		await browser.open(`http://127.0.0.1:${fixture.server.port}${row}`);
		await browser.wait(`document.querySelector('.viewer-panel iframe')`);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('.viewer-head').textContent`),
			/Demo artifact.*html · version 2/,
		);
		assert.equal(await browser.evaluate<string>("location.pathname+location.search"), `/s/${id}`);
		await browser.click('button[aria-label="Close viewer"]');
		await browser.wait(
			`!document.querySelector('.viewer-panel') && document.querySelector('a[aria-label="Open Demo artifact"]')`,
		);
	});
	it("docks the artifact list on the right on wide screens, under its viewer, and toggles it from the top bar", async () => {
		const button = 'button[aria-label="Artifacts (2)"]';
		const docked = "document.querySelectorAll('#side-dock [data-testid=artifact-panel] .artifact-row').length===2";
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
		// A version opens its viewer above the list; Back returns to the list, still docked.
		await browser.click("#side-dock .artifact-row");
		await browser.wait(`document.querySelector('.viewer-panel iframe') && ${docked}`);
		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('.viewer-panel') && ${docked}`);
		await browser.click(button);
		await browser.wait("!document.querySelector('#side-dock [data-testid=artifact-panel]')");
		await browser.click(button);
		await browser.wait(docked);
		// One thing at a time: a run's activity replaces the list, the list replaces the activity.
		await browser.click("[data-testid=activity]");
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
