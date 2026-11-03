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
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(
			`document.querySelector('input[aria-label="Search sessions and messages"]')&&!document.querySelector('.offline')`,
		);
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', "Search fixture"));
		await browser.wait(`[...document.querySelectorAll('.session-title')].some(e=>e.textContent==='Search fixture')`);
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', "Unique search needle"));
		await browser.wait(`document.querySelector('.hit')?.textContent.includes('Unique search needle')`);
		await sessions.archive({ id: session.id }, BACKGROUND_CONTEXT);
		// Refresh the submitted query, as mobile does on an edit; toggles then query the archive scope.
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', "Unique search needle "));
		await browser.wait(`!document.querySelector('.hit')`);
		await browser.click(".drawer-foot .foot-button");
		await browser.wait(`document.querySelector('.hit')?.textContent.includes('Unique search needle')`);
		assert(
			(await search.search({ query: "Unique search needle", archived: true }, BACKGROUND_CONTEXT)).messages.length >
				0,
		);
		await browser.click(".hit");
		await browser.wait(`location.pathname==='/s/${session.id}'`);
		await until(sessions.sessions, (rows) => rows?.find((row) => row.id === session.id)?.archivedAt === null);
		await browser.evaluate(input('input[aria-label="Search sessions and messages"]', ""));
		await browser.click(".drawer-foot .foot-button");
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
	it("opens a sent-file card as a conservative viewer and explicitly downloads the same snapshot", async () => {
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		await chat.send({ text: "send-file", requestId: "snapshot" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => JSON.stringify(view?.entries).includes("created.txt"));
		await browser.wait(`document.querySelector('button[aria-label="Open created.txt"]')`);
		await browser.click('button[aria-label="Open created.txt"]');
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
