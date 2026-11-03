// Main-view controls exercise real browser events against fake providers and disposable data.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const input = (selector: string, value: string) =>
	`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
describe("chat control parity", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, id: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		id = (
			await (
				await holdIn(fixture.browser(), Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Control parity" }, BACKGROUND_CONTEXT)
		).id;
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	it("shows one canonical toolbar, opens model/cost/share from the footer, and counts separate browser pages", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('.session-stats .client-count')?.textContent.trim()==='1'`);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.topbar>button')].map(e=>e.getAttribute('aria-label'))`,
			),
			["Sessions", "Terminal", "Workspace files and changes", "Session options"],
		);
		await browser.click('button[aria-label="Model and thinking"]');
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Model]')`);
		await browser.click("[role=dialog] button[aria-label=Close]");
		const second = await Browser.start();
		try {
			await second.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
			await browser.wait(`document.querySelector('.session-stats .client-count')?.textContent.trim()==='2'`);
		} finally {
			await second.close();
		}
		await browser.wait(`document.querySelector('.session-stats .client-count')?.textContent.trim()==='1'`);
		await browser.click(".client-count");
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Share]')`);
		await browser.click("[role=dialog] button[aria-label=Close]");
		await browser.evaluate(input(".composer textarea", "hello controls"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(
			`document.querySelector('.messages .assistant')?.textContent.includes('Echo: hello controls') && document.querySelector('.cost-link')`,
		);
		await browser.click(".cost-link");
		await browser.wait(`document.querySelector('.cost-table tbody tr')`);
		await browser.click("[role=dialog] button[aria-label=Close]");
	});
	it("keeps unsent draft/attachments while navigating and relocates through both cwd entries without losing history", async () => {
		await browser.metrics(1280, 900);
		await browser.evaluate(input(".composer textarea", "Unsent draft"));
		await browser.evaluate(
			`(()=>{const d=new DataTransfer();d.items.add(new File(['kept'],'kept.txt',{type:'text/plain'}));const m=document.querySelector('main');m.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:d}));m.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()`,
		);
		await browser.wait(`document.querySelector('.attachment-name')?.textContent==='kept.txt'`);
		await browser.click(".new-session");
		await browser.wait(
			`location.pathname==='/' && document.querySelector('.new-session-view .composer textarea') && document.querySelector('.attachment-name')`,
		);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('.composer textarea').value`),
			"Unsent draft",
		);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('.attachment-name').textContent`),
			"kept.txt",
		);
		await browser.evaluate(
			`[...document.querySelectorAll('.session-main')].find(e=>e.querySelector('.session-title').textContent==='Control parity').classList.add('test-return')`,
		);
		await browser.click(".test-return");
		await browser.wait(
			`location.pathname==='/s/${id}' && document.querySelector('.chat .composer textarea') && document.querySelector('button[aria-label="Remove kept.txt"]')`,
		);
		await browser.click('button[aria-label="Remove kept.txt"]');
		await browser.evaluate(input(".composer textarea", ""));
		for (const [directory, viaOptions] of [
			[join(fixture.workspace, "moved"), false],
			[fixture.workspace, true],
		] as const) {
			mkdirSync(directory, { recursive: true });
			if (viaOptions) {
				await browser.click('.topbar button[aria-label="Session options"]');
				await browser.click("[role=dialog] .row-button:nth-child(2)");
			} else await browser.click(".title-cwd");
			await browser.wait(`document.querySelector('.directory-use:not(:disabled)')`);
			assert(
				await browser.evaluate<boolean>(
					`document.querySelector('[role=dialog]').getAttribute('aria-label')==='Working directory'`,
				),
			);
			await browser.evaluate(input("input[aria-label=Directory]", directory));
			await browser.evaluate(`document.querySelector('input[aria-label=Directory]').form.requestSubmit()`);
			await browser.wait(
				`document.querySelector('.directory-use:not(:disabled)')?.textContent.trim()===${JSON.stringify(`Use ${directory}`)}`,
			);
			await browser.click(".directory-use");
			await browser.wait(`document.querySelector('.title-cwd')?.textContent===${JSON.stringify(directory)}`);
			await browser.wait(
				`document.querySelector('.messages .assistant')?.textContent.includes('Echo: hello controls')`,
			);
		}
		const session = await holdIn(fixture.browser(), Sessions, {}, "owner");
		await until(session.sessions, (list) => list?.find((row) => row.id === id)?.cwd === fixture.workspace);
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		await chat.send({ text: "slow controls", requestId: "slow-controls" }, BACKGROUND_CONTEXT);
		await browser.wait(`document.querySelector('button[aria-label=Stop]')`);
		await browser.click(".title-cwd");
		await browser.wait(`document.querySelector('.directory-use:not(:disabled)')`);
		await browser.click(".directory-use");
		await browser.wait(
			`document.querySelector('.toast')?.textContent.includes('Stop the current run before changing directory')`,
		);
		await browser.click("button[aria-label=Stop]");
	});
});
