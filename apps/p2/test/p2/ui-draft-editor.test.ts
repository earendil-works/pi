// The composer's editor (plugins/chat/draft-editor.tsx): files as pills where the text references them, placed at the
// caret, moved by dragging or the pill's menu, removed with Backspace, every change undone and redone with the keys;
// the model gets each file in place, and the transcript shows each reference where the message put it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat } from "../../plugins/chat/contract.ts";
import { SESSIONS_OWNER, Sessions } from "../../plugins/sessions/contract.ts";
import { fileReferences } from "../../src/runtime/references.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdWith, startFixture, until } from "./helpers.ts";

const EDITOR = ".composer .draft-editor";
/** The draft as the composer keeps it (it persists it for the tab). */
const DRAFT = `JSON.parse(sessionStorage.getItem('p2-draft') ?? '{"text":""}').text`;
/** Pastes PNGs named `names` into the editor (a 1x1 image each). */
const PASTE = `window.pastePng=(names)=>{const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));const d=new DataTransfer();for(const name of names)d.items.add(new File([png],name,{type:'image/png'}));document.querySelector(${JSON.stringify(EDITOR)}).dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))}`;

describe("draft editor", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, id: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		id = (
			await (
				await holdWith(fixture.browser(), Sessions, {}, ...SESSIONS_OWNER)
			).create({ cwd: fixture.workspace, title: "Pills" }, BACKGROUND_CONTEXT)
		).id;
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	const draft = () => browser.evaluate<string>(DRAFT);
	const names = async () => fileReferences(await draft()).map((reference) => reference.label);
	const type = (text: string) => browser.call("Input.insertText", { text });
	const key = async (code: string, keyName: string, modifiers = 0) => {
		const base = { key: keyName, code, modifiers, windowsVirtualKeyCode: keyName === "Backspace" ? 8 : 90 };
		// macOS Chromium edits only on a named command (Linux edits on the key alone).
		const commands = keyName === "Backspace" ? { commands: ["deleteBackward"] } : {};
		await browser.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...commands });
		await browser.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
	};
	const undo = () => key("KeyZ", "z", 2);
	const redo = () => key("KeyZ", "z", 2 | 8);
	const center = (selector: string) =>
		browser.evaluate<{ x: number; y: number }>(
			`(()=>{const r=${selector}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
	const pill = (index: number) => `document.querySelectorAll('.draft-pill')[${index}]`;

	it("places pills at the caret, moves and removes them, undoes every step, and sends each file in place", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector(${JSON.stringify(EDITOR)}) && !document.querySelector('.offline')`);
		await browser.evaluate(PASTE);
		await browser.evaluate(`document.querySelector(${JSON.stringify(EDITOR)}).focus()`);

		await type("compare ");
		await browser.evaluate(`pastePng(['a.png'])`);
		await browser.wait(`document.querySelectorAll('.draft-pill').length === 1`);
		await type(" with ");
		await browser.evaluate(`pastePng(['b.png'])`);
		await browser.wait(`document.querySelectorAll('.draft-pill').length === 2`);
		await type(".");
		await browser.wait(`${DRAFT}.endsWith('.')`);
		assert.match(await draft(), /^compare !\[a\.png\]\(attachment:[\w-]+\) with !\[b\.png\]\(attachment:[\w-]+\)\.$/);
		assert.deepEqual(
			await browser.evaluate<string[]>(`[...document.querySelectorAll('.draft-pill')].map(e=>e.textContent)`),
			["Image 1", "Image 2"],
		);

		// Undo takes back the typing, then the pasted pill; redo puts both back.
		const full = await draft();
		await undo();
		await browser.wait(`!${DRAFT}.endsWith('.')`);
		await undo();
		await browser.wait(`document.querySelectorAll('.draft-pill').length === 1`);
		assert.match(await draft(), /^compare !\[a\.png\]\(attachment:[\w-]+\) with $/);
		await redo();
		await browser.wait(`document.querySelectorAll('.draft-pill').length === 2`);
		await redo();
		await browser.wait(`${DRAFT} === ${JSON.stringify(full)}`);

		// Backspace removes the pill before the caret as one piece; undo brings it back.
		await key("Backspace", "Backspace");
		await browser.wait(`${DRAFT}.endsWith(')')`);
		await key("Backspace", "Backspace");
		await browser.wait(`document.querySelectorAll('.draft-pill').length === 1`);
		await undo();
		await browser.wait(`document.querySelectorAll('.draft-pill').length === 2`);
		assert.deepEqual(await names(), ["a.png", "b.png"]);
		await undo();
		await browser.wait(`${DRAFT} === ${JSON.stringify(full)}`);

		// Dragging the second pill to the start of the text moves its file there; the words stay.
		const from = await center(pill(1));
		const box = await browser.evaluate<{ x: number; y: number }>(
			`(()=>{const r=document.querySelector(${JSON.stringify(EDITOR)}).getBoundingClientRect();return {x:r.left+1,y:r.top+8}})()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 });
		for (let step = 1; step <= 5; step++)
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: from.x + ((box.x - from.x) * step) / 5,
				y: from.y + ((box.y - from.y) * step) / 5,
				button: "left",
				buttons: 1,
			});
		await browser.wait(`document.querySelector('.draft-drop-caret')`);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...box, button: "left", clickCount: 1 });
		await browser.wait(`${DRAFT}.startsWith('![b.png]')`);
		assert.match(await draft(), /^!\[b\.png\]\(attachment:[\w-]+\)compare !\[a\.png\]\(attachment:[\w-]+\) with \.$/);
		assert.equal(
			await browser.evaluate<number>(`document.querySelectorAll('.draft-drop-caret, .draft-pill-ghost').length`),
			0,
		);
		await undo();
		await browser.wait(`${DRAFT} === ${JSON.stringify(full)}`);

		// A press without moving opens the pill's menu: Earlier swaps it with the one before.
		await browser.click(`.draft-pill:nth-of-type(2)`);
		await browser.wait(`document.querySelector('.draft-pill-menu')`);
		await browser.click(`.draft-pill-actions button:first-child`);
		await browser.wait(`${DRAFT}.startsWith('compare ![b.png]')`);
		assert.deepEqual(await names(), ["b.png", "a.png"]);
		await browser.evaluate(
			`document.querySelector('.draft-pill-menu') && document.querySelector(${JSON.stringify(EDITOR)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
		);
		await browser.wait(`!document.querySelector('.draft-pill-menu')`);

		// Focus given back from code returns the caret where it was; a click puts it where it lands.
		const caret = `(()=>{const e=document.querySelector(${JSON.stringify(EDITOR)});const r=getSelection().getRangeAt(0);const p=document.createRange();p.setStart(e,0);p.setEnd(r.startContainer,r.startOffset);return p.toString().replaceAll('\\u200B','').length})()`;
		await browser.evaluate(`document.querySelector(${JSON.stringify(EDITOR)}).blur()`);
		await browser.evaluate(`document.querySelector(${JSON.stringify(EDITOR)}).focus()`);
		const kept = await browser.evaluate<number>(caret);
		assert(kept > 0, "the caret is not sent to the start");
		await browser.evaluate(`document.querySelector(${JSON.stringify(EDITOR)}).blur()`);
		const start = await browser.evaluate<{ x: number; y: number }>(
			`(()=>{const r=document.createRange();r.setStart(document.querySelector(${JSON.stringify(EDITOR)}).firstChild,1);const b=r.getClientRects()[0];return {x:b.left,y:b.top+b.height/2}})()`,
		);
		await browser.clickPoint(start.x, start.y);
		assert.equal(await browser.evaluate<number>(caret), 1);

		// Sent: the model reads each image where the text put it, inside its tag with its copy's path.
		await browser.click("button[aria-label=Send]");
		await browser.wait(
			`document.querySelectorAll('.bubble .message-ref').length === 2 && !document.querySelector('.draft-pill')`,
		);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.bubble .message-ref')].map(e=>e.textContent)`,
			),
			["b.png", "a.png"],
		);
		const chat = await holdWith(fixture.browser(), Chat, { session: id, conversation: 1 }, ...CHAT_PARTICIPANT);
		const view = await until(chat.view, (value) => (value?.entries ?? []).some((entry) => entry.kind === "p2.input"));
		const message = view?.entries.find((entry) => entry.kind === "p2.input")?.model?.[0] as UserMessage;
		assert(Array.isArray(message.content));
		const parts = message.content.slice(1).map((part) => (part.type === "text" ? part.text : part.type));
		assert.equal(parts.length, 5, JSON.stringify(parts));
		assert.match(parts[0]!, /^compare <image name=\[Image #1\] path="[^"]+-b\.png">$/);
		assert.equal(parts[1], "image");
		assert.match(parts[2]!, /^<\/image> with <image name=\[Image #2\] path="[^"]+-a\.png">$/);
		assert.equal(parts[3], "image");
		assert.equal(parts[4], "</image>.");
	});
});
