// Chat mode in a real browser: the composer chip, chat messages in the transcript, and a mention (fake provider).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

const input = (selector: string, value: string) =>
	`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;

describe("chat mode in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let id: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		id = (
			await (
				await holdIn(fixture.browser(), Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Chat" }, BACKGROUND_CONTEXT)
		).id;
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("switches chat mode, shows chat messages, and answers a mention", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.click(".composer button.chat-mode");
		await browser.wait(`document.querySelector('.composer button.chat-mode')?.getAttribute('aria-pressed')==='true'`);

		await browser.evaluate(input(".composer textarea", "Lunch first?"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(`document.querySelector('.chat-message .bubble')?.textContent.includes('Lunch first?')`);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('.chat-message .speaker').textContent`),
			/Owner · chat/,
		);
		await browser.wait(`document.querySelector('.composer button.chat-mode')?.textContent==='Chat · 1'`);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.messages .assistant').length`), 0);

		// The switch lives in the conversation: a page reload finds it on, and the message is still there.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('.composer button.chat-mode')?.getAttribute('aria-pressed')==='true'`);
		await browser.wait(`document.querySelector('.chat-message .bubble')?.textContent.includes('Lunch first?')`);

		await browser.evaluate(input(".composer textarea", "@pi where should we go?"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(`document.querySelector('.messages .assistant')?.textContent.includes('Owner: Lunch first?')`);
		// The mention shows what the owner wrote, from its entry's data, and how much chat went with it.
		const mention = `[...document.querySelectorAll('.user:not(.chat-message) .bubble')].at(-1)`;
		assert.equal(
			await browser.evaluate<string>(`${mention}.querySelector('.bubble-note')?.textContent`),
			"with 1 chat message",
		);
		assert.match(await browser.evaluate<string>(`${mention}.textContent`), /^Owner@pi where should we go\?/);
		await browser.wait(`document.querySelector('.composer button.chat-mode')?.textContent==='Chat'`);
	});

	it("replies with the hover button and a long press, and jumps from a reply's quote to the original", async () => {
		await browser.metrics(1280, 900);
		const reply = (label: string) => `.messages [aria-label="Reply to ${label}"]`;
		// Desktop: the button appears next to a person's message on hover.
		const bubble = await browser.evaluate<{ x: number; y: number }>(
			`(()=>{const r=document.querySelector('.chat-message .bubble').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: bubble.x, y: bubble.y });
		await browser.wait(`getComputedStyle(document.querySelector(${JSON.stringify(reply("Owner"))})).opacity==='1'`);
		await browser.click(reply("Owner"));
		await browser.wait(`document.querySelector('.composer .replying')?.textContent==='Replying to Owner'`);
		await browser.click('.composer button[aria-label="Cancel reply"]');
		await browser.wait(`!document.querySelector('.composer .replying')`);
		await browser.click(reply("Owner"));
		await browser.evaluate(input(".composer textarea", "The place downstairs"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(`document.querySelector('.reply-quote')?.textContent==='Owner Lunch first?'`);
		await browser.wait(`!document.querySelector('.composer .replying')`);

		// The quoted line leads to the message it answers.
		const original = await browser.evaluate<string>(
			`document.querySelector('.chat-message').getAttribute('data-entry')`,
		);
		await browser.evaluate(`document.querySelector('.chat-message').classList.remove('flash')`);
		await browser.click(".reply-quote");
		await browser.wait(`document.querySelector('[data-entry="${original}"]').classList.contains('flash')`);

		// Phone: a long press on Pi's answer starts a reply to it.
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true });
		const answer = await browser.evaluate<{ x: number; y: number }>(
			`(()=>{const e=[...document.querySelectorAll('.assistant[data-entry]')].at(-1);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(r.height/2,20)}})()`,
		);
		await browser.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [answer] });
		await new Promise((resolve) => setTimeout(resolve, 1000)); // the long press needs 500 ms; leave room under load
		await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await browser.wait(`document.querySelector('.composer .replying')?.textContent==='Replying to Pi'`);
		await browser.evaluate(input(".composer textarea", "Agreed"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(
			`[...document.querySelectorAll('.reply-quote')].some(e=>e.textContent.startsWith('Pi Echo:'))`,
		);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
	});
});
