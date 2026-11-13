// The scope prompt (plugins/scope-prompt): holding Cmd does nothing; a double tap of it (or Cmd+., or the command menu)
// switches pointing mode on, which outlines what is under the pointer (a transcript message in the chat pane, a session's
// row in the sidebar); a click opens the composer there instead of acting on the page, and what is typed reaches the
// Familiar with a `<scope>` block naming the target.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Familiar } from "../../plugins/familiar/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("the scope prompt", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		await fixture
			.browser()
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("outlines what the pointer is on and sends a prompt about it to the Familiar", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const shown = (await sessions.create({ cwd: fixture.workspace, title: "Ordinary" }, BACKGROUND_CONTEXT)).id;
		const other = (await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(owner, Chat, { session: shown, conversation: 1 }, "participant");
		await chat.send({ text: "hello there", requestId: "scope-1" }, BACKGROUND_CONTEXT);
		await browser.metrics(1280, 900);
		// macOS keys (Cmd), whatever the host is.
		const userAgent = await browser.evaluate<string>("navigator.userAgent");
		await browser.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${shown}`);
		await browser.wait(`document.querySelector('.user[data-entry]')`);
		await browser.wait(`document.querySelector('[data-session="${other}"] .session-main')`);

		const centre = (selector: string) =>
			browser.evaluate<{ x: number; y: number }>(
				`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
			);
		const move = async (selector: string, modifiers = 0) => {
			const { x, y } = await centre(selector);
			await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
			return { x, y };
		};
		const click = async (point: { x: number; y: number }, modifiers = 0) => {
			await browser.call("Input.dispatchMouseEvent", {
				type: "mousePressed",
				...point,
				button: "left",
				clickCount: 1,
				modifiers,
			});
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				...point,
				button: "left",
				clickCount: 1,
				modifiers,
			});
		};
		const key = async (type: "rawKeyDown" | "keyUp", key: string, code: string, keyCode: number, modifiers = 0) =>
			browser.call("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
		const tapCommand = async () => {
			await key("rawKeyDown", "Meta", "MetaLeft", 91, 4);
			await key("keyUp", "Meta", "MetaLeft", 91);
		};
		const label = `document.querySelector('.scope-outline-label')?.textContent`;
		const mode = `document.querySelector('.scope-mode')`;

		// Holding Cmd does nothing: no outline, and Cmd+V-like chords never count as taps.
		await key("rawKeyDown", "Meta", "MetaLeft", 91, 4);
		await move(".user[data-entry]", 4);
		await key("rawKeyDown", "v", "KeyV", 86, 4);
		await key("keyUp", "v", "KeyV", 86, 4);
		await key("keyUp", "Meta", "MetaLeft", 91);
		await tapCommand();
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(
			await browser.evaluate<boolean>(`Boolean(${mode} || document.querySelector('.scope-outline'))`),
			false,
		);
		await new Promise((resolve) => setTimeout(resolve, 500));

		// A double tap of Cmd switches pointing on: the chat's message is outlined at once, then the sidebar's row.
		await tapCommand();
		await tapCommand();
		await browser.wait(mode);
		await browser.wait(`${label} === 'Chat › Message'`);
		const point = await move(`[data-session="${other}"] .session-main`);
		await browser.wait(`${label}?.startsWith('Sidebar › ') && ${label}?.endsWith(' › Other')`);

		// A plain click picks it: the composer opens there, the row does not open its session, the mode ends.
		await click(point);
		await browser.wait(`document.activeElement === document.querySelector('.scope-composer textarea')`);
		assert.equal(await browser.evaluate<string>(`location.pathname`), `/s/${shown}`);
		assert.equal(await browser.evaluate<boolean>(`Boolean(${mode})`), false);
		assert.equal(await browser.evaluate<string>(`document.querySelector('.scope-step.chosen').textContent`), "Other");

		// Enter sends it to the Familiar with the scope; the page stays.
		await browser.call("Input.insertText", { text: "summarize this" });
		await key("rawKeyDown", "Enter", "Enter", 13);
		await browser.wait(`document.querySelector('.scope-sent') && !document.querySelector('.scope-composer')`);
		const familiar = await holdIn(owner, Familiar, {}, "owner");
		const id = await until(familiar.session, (value) => typeof value === "string");
		const familiarChat = await holdIn(owner, Chat, { session: String(id), conversation: 1 }, "participant");
		const view = await until(familiarChat.view, (value) => JSON.stringify(value).includes("summarize this"));
		const text = JSON.stringify(view);
		assert.ok(text.includes("<scope>"));
		assert.ok(text.includes(other), "the target names the pointed session");
		assert.ok(text.includes(shown), "the page names the open session");
		assert.equal(await browser.evaluate<string>(`location.pathname`), `/s/${shown}`);

		// Cmd+. switches it on too; Escape switches it off without picking.
		await key("rawKeyDown", ".", "Period", 190, 4);
		await browser.wait(mode);
		await key("rawKeyDown", "Escape", "Escape", 27);
		await browser.wait(
			`!${mode} && !document.querySelector('.scope-outline') && !document.querySelector('.scope-composer')`,
		);

		// The command menu's "Prompt anywhere" switches it on; a pick on the message, then Escape closes the composer.
		await key("rawKeyDown", "k", "KeyK", 75, 4);
		await browser.wait(`document.activeElement?.matches('.command-menu input')`);
		await browser.call("Input.insertText", { text: "Prompt anywhere" });
		await browser.wait(
			`document.querySelector('.command-menu [aria-selected="true"]')?.textContent.includes('Prompt anywhere')`,
		);
		await key("rawKeyDown", "Enter", "Enter", 13);
		await browser.wait(mode);
		await click(await move(".user[data-entry]"));
		await browser.wait(`document.querySelector('.scope-step.chosen')?.textContent === 'Message'`);
		await key("rawKeyDown", "Escape", "Escape", 27);
		await browser.wait(`!document.querySelector('.scope-composer')`);

		// A prompt about the open session's chat goes to its conversation as the person's message, not to the Familiar:
		// the transcript shows the text with a note, the scope goes along as context.
		await key("rawKeyDown", ".", "Period", 190, 4);
		await browser.wait(mode);
		await click(await move(".user[data-entry]"));
		await browser.wait(`document.querySelector('.scope-destination .scope-step.chosen')?.textContent === 'Chat'`);
		await browser.call("Input.insertText", { text: "explain this" });
		await key("rawKeyDown", "Enter", "Enter", 13);
		await browser.wait(`document.querySelector('.scope-sent')?.textContent === 'Sent to Chat'`);
		const own = JSON.stringify(await until(chat.view, (value) => JSON.stringify(value).includes("explain this")));
		assert.ok(own.includes("p2.view-input") && own.includes("scope Chat › Message"), own);
		// The model's copy carries the scope: the message pointed at, by entry and text.
		assert.ok(own.includes(String.raw`\"text\": \"hello there\"`), own);
		await browser.wait(`document.body.textContent.includes('with scope Chat › Message')`);
		assert.ok(!JSON.stringify(familiarChat.view.value).includes("explain this"));

		familiarChat.release();
		familiar.release();
		chat.release();
		sessions.release();
	});
});
