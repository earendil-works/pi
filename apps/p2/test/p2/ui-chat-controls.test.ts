// Main-view controls exercise real browser events against fake providers and disposable data.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests, COMPOSER, setComposer } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const input = (selector: string, value: string) =>
	`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
/** The draft as the composer keeps it for the tab. */
const DRAFT = `JSON.parse(sessionStorage.getItem('p2-draft') ?? '{"text":""}').text`;
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
		await browser.signIn(fixture.owner);
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
			["Sessions", "Annotate", "Terminal", "Workspace files and changes", "Session options"],
		);
		await browser.click('button[aria-label="Model and thinking"]');
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Model]')`);
		await browser.click("[role=dialog] button[aria-label=Close]");
		const second = await Browser.start();
		await second.signIn(fixture.owner);
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
		await browser.evaluate(setComposer("hello controls"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(
			`document.querySelector('.messages .assistant')?.textContent.includes('Echo: hello controls') && document.querySelector('.cost-link')`,
		);
		// The sent message and the answer show their time, with the full moment as the tooltip; the message has Copy. The
		// answer ends the conversation: no Branch (the composer sends in a new branch instead).
		const times = await browser.evaluate<{ actions: string[]; sent: number; title: boolean }[]>(
			`[...document.querySelectorAll('.messages .user, .messages .assistant')].filter((e) => e.querySelector('.message-actions')).map((e) => { const time = e.querySelector('.message-actions .message-time'); return { actions: [...e.querySelector('.message-actions').children].map((child) => child.classList.contains('message-time') ? 'time' : child.getAttribute('aria-label')), sent: Date.now() - Date.parse(time.dateTime), title: Boolean(time.title) }; })`,
		);
		assert.deepEqual(
			times.map(({ actions, title }) => ({ actions: actions.filter((action) => action !== "Reply"), title })),
			[
				{ actions: ["time", "Edit", "Copy"], title: true },
				{ actions: ["Copy", "time"], title: true },
			],
		);
		assert.ok(times.every(({ sent }) => sent >= 0 && sent < 60_000));
		await browser.click(".cost-link");
		await browser.wait(`document.querySelector('.cost-table tbody tr')`);
		await browser.click("[role=dialog] button[aria-label=Close]");
	});
	it("keeps an unsent draft and its files while navigating and relocates through both cwd entries without losing history", async () => {
		await browser.metrics(1280, 900);
		await browser.evaluate(setComposer("Unsent draft"));
		await browser.evaluate(
			`(()=>{const d=new DataTransfer();d.items.add(new File(['kept'],'kept.txt',{type:'text/plain'}));const m=document.querySelector('main');m.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:d}));m.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()`,
		);
		await browser.wait(`document.querySelector('.draft-pill')?.textContent==='kept.txt'`);
		await browser.click(".new-session");
		await browser.wait(
			`location.pathname==='/new' && document.querySelector('.new-session-view ${COMPOSER} .draft-pill')`,
		);
		// The draft keeps its text and the file's reference, wherever the drop placed it.
		const draft = await browser.evaluate<string>(DRAFT);
		assert.equal(draft.replace(/\[kept\.txt\]\(attachment:[\w-]+\)/, ""), "Unsent draft");
		assert.equal(await browser.evaluate<string>(`document.querySelector('.draft-pill').textContent`), "kept.txt");
		await browser.evaluate(
			`[...document.querySelectorAll('.session-main')].find(e=>e.querySelector('.session-title').textContent==='Control parity').classList.add('test-return')`,
		);
		await browser.click(".test-return");
		await browser.wait(
			`location.pathname==='/s/${id}' && document.querySelector('.chat ${COMPOSER} .draft-pill')?.textContent==='kept.txt'`,
		);
		// The pill's menu removes the file and its reference.
		await browser.click(".draft-pill");
		await browser.wait(`document.querySelector('.draft-pill-menu')`);
		await browser.evaluate(
			`[...document.querySelectorAll('.draft-pill-actions button')].find(e=>e.textContent==='Remove').click()`,
		);
		await browser.wait(`!document.querySelector('.draft-pill') && ${DRAFT}==='Unsent draft'`);
		await browser.evaluate(setComposer(""));
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
	it("places pasted images as pills like picked files and leaves text pastes to the editor", async () => {
		const pasted = (
			await (
				await holdIn(fixture.browser(), Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Paste" }, BACKGROUND_CONTEXT)
		).id;
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${pasted}`);
		await browser.wait(`document.querySelector('.chat ${COMPOSER}')`);
		// A 1x1 PNG; `paste(text, names)` dispatches a paste of that text and PNGs and returns whether it was cancelled.
		await browser.evaluate(
			`window.paste=(text,names)=>{const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));const d=new DataTransfer();if(text)d.setData('text/plain',text);for(const name of names)d.items.add(new File([png],name,{type:'image/png'}));return !document.querySelector('${COMPOSER}').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))}`,
		);
		assert.equal(await browser.evaluate<boolean>(`paste('', ['image.png', ''])`), true);
		await browser.wait(`document.querySelectorAll('.draft-pill img').length===2`);
		const pills = `[...document.querySelectorAll('.draft-pill')]`;
		assert.deepEqual(await browser.evaluate<string[]>(`${pills}.map(e=>e.textContent)`), ["Image 1", "Image 2"]);
		assert.deepEqual(await browser.evaluate<string[]>(`${pills}.map(e=>e.title)`), ["image.png", "pasted-image.png"]);
		// Text with a picture of it (an Office copy) and plain text keep the default paste and attach nothing.
		assert.equal(await browser.evaluate<boolean>(`paste('a1\\tb1', ['cells.png'])`), false);
		assert.equal(await browser.evaluate<boolean>(`paste('just text', [])`), false);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.draft-pill').length`), 2);
		await browser.evaluate(`document.querySelector('${COMPOSER}').focus()`);
		await browser.call("Input.insertText", { text: " with screenshots" });
		await browser.wait(`${DRAFT}.endsWith(' with screenshots')`);
		await browser.click("button[aria-label=Send]");
		// The bubble shows each file where the text referenced it; none is listed apart.
		await browser.wait(
			`document.querySelectorAll('.bubble .message-ref').length===2 && !document.querySelector('.draft-pill')`,
		);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.bubble .message-ref')].map(e=>e.textContent)`,
			),
			["image.png", "pasted-image.png"],
		);
		assert.equal(await browser.evaluate<boolean>(`Boolean(document.querySelector('.bubble-files'))`), false);
		// The message shows before it is sent (plugins/chat/outbox.ts), even before the conversation has loaded; the
		// uploads follow once its chat object is live.
		const uploaded = () =>
			readdirSync(join(fixture.dataDir, "uploads", pasted))
				.map((file) => file.slice(37))
				.sort();
		await poll(() => existsSync(join(fixture.dataDir, "uploads", pasted)) && uploaded().length === 2);
		assert.deepEqual(uploaded(), ["image.png", "pasted-image.png"]);
	});
});
