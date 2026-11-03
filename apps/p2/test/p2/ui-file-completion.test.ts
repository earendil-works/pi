// P7c of p2-tui-port.md: `@` and Tab file completion in the web composer (a p2 addition; Pi Mobile has none), with
// real key events: the popover's Enter/Escape win over send/stop, IME composition never opens it, `@pi` is never a
// file, Tab completes a path-like token.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

const key = (browser: Browser, name: string, code: number) =>
	(async () => {
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
	})();
const enter = (browser: Browser) =>
	(async () => {
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
	})();
const value = (browser: Browser) => browser.evaluate<string>(`document.querySelector('.composer textarea').value`);
const popover = (browser: Browser) =>
	browser.evaluate<string>(`document.querySelector('.file-completion')?.textContent ?? ''`);

describe("web composer file completion", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let id: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		mkdirSync(join(fixture.workspace, "src"));
		writeFileSync(join(fixture.workspace, "src/parser.ts"), "");
		writeFileSync(join(fixture.workspace, "pipe.ts"), "");
		writeFileSync(join(fixture.workspace, "README.md"), "");
		id = (
			await (
				await holdIn(fixture.browser(), Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Completion" }, BACKGROUND_CONTEXT)
		).id;
		browser = await Browser.start();
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.click(".composer textarea");
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	const clear = () =>
		browser.evaluate(
			`(()=>{const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
		);

	it("opens on @, applies with Enter instead of sending, closes with Escape", async () => {
		await browser.call("Input.insertText", { text: "fix @pars" });
		await browser.wait(`document.querySelector('.file-completion')?.textContent.includes('src/parser.ts')`);
		await enter(browser);
		await browser.wait(`document.querySelector('.composer textarea').value==='fix @src/parser.ts '`);
		assert.equal(await popover(browser), "");
		assert.equal(
			await browser.evaluate<number>(`document.querySelectorAll('.messages .user').length`),
			0,
			"Enter applied the completion, it did not send",
		);
		await browser.call("Input.insertText", { text: "@READ" });
		await browser.wait(`document.querySelector('.file-completion')?.textContent.includes('README.md')`);
		await key(browser, "Escape", 27);
		await browser.wait(`!document.querySelector('.file-completion')`);
		assert.equal(await value(browser), "fix @src/parser.ts @READ");
		await clear();
	});

	it("never completes @pi as a file; out-of-scope prefixes show the hint", async () => {
		await browser.call("Input.insertText", { text: "ask @pi" });
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert(!(await popover(browser)).includes("pipe.ts"), "@pi is the agent mention, not pipe.ts");
		await clear();
		await browser.call("Input.insertText", { text: "see @../x" });
		await browser.wait(`document.querySelector('.file-completion-hint')?.textContent.includes('session directory')`);
		await key(browser, "Escape", 27);
		await clear();
	});

	it("Tab completes a path-like token; IME composition never opens the popover", async () => {
		await browser.call("Input.insertText", { text: "open src/pa" });
		await browser.call("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			key: "Tab",
			code: "Tab",
			windowsVirtualKeyCode: 9,
		});
		await browser.call("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Tab",
			code: "Tab",
			windowsVirtualKeyCode: 9,
		});
		await browser.wait(`document.querySelector('.composer textarea').value==='open src/parser.ts'`);
		assert.equal(
			await browser.evaluate<boolean>(`document.activeElement===document.querySelector('.composer textarea')`),
			true,
			"Tab stayed in the composer",
		);
		await clear();
		await browser.call("Input.imeSetComposition", { text: "@pa", selectionStart: 3, selectionEnd: 3 });
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(await popover(browser), "", "no popover mid-composition");
		await browser.call("Input.insertText", { text: "@pa" });
		await clear();
	});
});
