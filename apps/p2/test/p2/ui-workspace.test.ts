// Structural workspace/terminal ports: real pointer navigation, draft persistence, live refresh and resize.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

const input = (selector: string, value: string) =>
	`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
describe("workspace and terminal structural parity", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, id: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		mkdirSync(join(fixture.workspace, "src"));
		writeFileSync(join(fixture.workspace, "src/hello.ts"), "export const answer = 41;\n");
		writeFileSync(join(fixture.workspace, "guide.md"), "# Guide\n\nWorkspace preview.\n");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture.workspace, stdio: "ignore" });
		git("init", "-q");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "add", ".");
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Initial fixture");
		writeFileSync(join(fixture.workspace, "src/hello.ts"), "export const answer = 42;\n");
		id = (
			await (
				await holdIn(fixture.browser(), Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Workspace parity" }, BACKGROUND_CONTEXT)
		).id;
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	async function open(width: number, height: number) {
		await browser.metrics(width, height);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(
			`document.querySelector('.topbar h1')?.textContent==='Workspace parity' && !document.querySelector('.offline')`,
		);
		if (await browser.evaluate<boolean>(`Boolean(document.querySelector('.workspace'))`))
			await browser.click('button[aria-label="Close workspace"]');
		await browser.click('button[aria-label="Workspace files and changes"]');
		await browser.wait(`document.querySelector('.workspace-tree .workspace-row.directory')`);
	}
	it("uses the canonical phone tree, previews, comment editor and Back; keeps unsent review drafts after reload", async () => {
		await open(390, 844);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('[class*="p2-workspace"]').length`), 0);
		await browser.click(".workspace-tree .workspace-row.directory");
		await browser.wait(`[...document.querySelectorAll('.workspace-name')].some(e=>e.textContent==='hello.ts')`);
		await browser.evaluate(
			`[...document.querySelectorAll('.workspace-row')].find(e=>e.querySelector('.workspace-name')?.textContent==='hello.ts').classList.add('test-file')`,
		);
		await browser.click(".test-file");
		await browser.wait(`document.querySelector('.diff-line button.diff-number')`);
		await browser.click(".diff-line button.diff-number");
		await browser.wait(
			`document.querySelector('textarea[aria-label=Comment]') && document.querySelector('.line-comment-actions')`,
		);
		await browser.evaluate(input("textarea[aria-label=Comment]", "Please explain this answer."));
		await browser.evaluate(
			`[...document.querySelectorAll('.line-comment-actions button')].find(e=>e.textContent==='Add comment').classList.add('test-add')`,
		);
		await browser.click(".test-add");
		await browser.wait(`document.querySelector('.review-bar')?.textContent.includes('1 comment')`);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`document.querySelector('.line-comment-text')?.textContent==='Please explain this answer.'`);
		await browser.click(".workspace-view button[aria-label=Back]");
		await browser.wait(
			`document.querySelector('.workspace-tree') && [...document.querySelectorAll('.workspace-name')].some(e=>e.textContent==='guide.md')`,
		);
		await browser.evaluate(
			`[...document.querySelectorAll('.workspace-row')].find(e=>e.querySelector('.workspace-name')?.textContent==='guide.md').classList.add('test-markdown')`,
		);
		await browser.click(".test-markdown");
		await browser.wait(`document.querySelector('.workspace-markdown h3')?.textContent==='Guide'`);
		await browser.click(".workspace-view button[aria-label=Back]");
		await browser.click(".workspace-tabs button[title=Comments]");
		await browser.wait(`document.querySelector('.comment-row')`);
		await browser.click(".review-bar .button.primary");
		await browser.wait(`!document.querySelector('.review-bar')`);
		await browser.click('button[aria-label="Close workspace"]');
		await browser.wait(`document.querySelector('.messages .user')?.textContent.includes('Review comments:')`);
	});
	it("shows changes/commits, searches with filters, follows filesystem changes, and measures/resizes the desktop panel", async () => {
		await open(1280, 900);
		await browser.click(".workspace-tabs button[title=Changes]");
		await browser.wait(
			`document.querySelector('.workspace-status.status-M') && document.querySelector('.commit-row')`,
		);
		await browser.click(".workspace-row[title=modified]");
		await browser.wait(`document.querySelector('.workspace-view .diff-line')`);
		await browser.click(".workspace-view button[aria-label=Back]");
		await browser.click(".commit-row");
		await browser.wait(`document.querySelector('.workspace-commit')`);
		await browser.click(".workspace-view button[aria-label=Back]");
		await browser.click(".workspace-tabs button[title=Search]");
		await browser.wait(`document.querySelector('input[aria-label="Search text in files"]')`);
		await browser.evaluate(input('input[aria-label="Search text in files"]', "answer"));
		await browser.evaluate(`document.querySelector('input[aria-label="Search text in files"]').form.requestSubmit()`);
		await browser.wait(`document.querySelector('.workspace-row.match')?.textContent.includes('hello.ts:1')`);
		await browser.click(".workspace-tabs button[title=Files]");
		writeFileSync(join(fixture.workspace, "new-visible.txt"), "Live change\n");
		await browser.wait(
			`[...document.querySelectorAll('.workspace-name')].some(e=>e.textContent==='new-visible.txt')`,
		);
		await browser.metrics(1600, 900);
		await browser.click('button[aria-label="Collapse sidebar"]');
		await browser.evaluate(
			`[...document.querySelectorAll('.workspace-row')].find(e=>e.querySelector('.workspace-name')?.textContent==='guide.md').classList.add('test-desktop-file')`,
		);
		await browser.click(".test-desktop-file");
		await browser.wait(`document.querySelector('.workspace.split .workspace-preview')`);
		await browser.click('button[aria-label="Close file"]');
		await browser.wait(`!document.querySelector('.workspace-preview')`);
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(()=>{const r=document.querySelector('.workspace-resize').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
		await browser.call("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: point.x - 80,
			y: point.y,
			button: "left",
			buttons: 1,
		});
		await browser.call("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: point.x - 80,
			y: point.y,
			button: "left",
			clickCount: 1,
		});
		await browser.wait(`Number(localStorage.getItem('pi-workspace-width'))>320`);
		await browser.click('button[aria-label="Close workspace"]');
	});
	it("renders canonical terminal controls even while transport is unavailable, toggles extra keys, moves and hides the panel", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(
			`document.querySelector('.topbar h1')?.textContent==='Workspace parity' && !document.querySelector('.offline')`,
		);
		if (await browser.evaluate<boolean>(`Boolean(document.querySelector('.workspace'))`))
			await browser.click('button[aria-label="Close workspace"]');
		await browser.click(".topbar button[aria-label=Terminal]");
		await browser.wait(`document.querySelector('.workspace .terminal')`);
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('.terminal-input').length`), 1);
		assert.equal(
			await browser.evaluate<number>(
				`document.querySelectorAll('.terminal-tabs button[aria-label="Hide terminal"]').length`,
			),
			0,
		);
		await browser.click('button[aria-label="Extra keys"]');
		await browser.wait(`document.querySelector('.terminal-keys')`);
		await browser.click('button[aria-label="Move terminal to the bottom"]');
		await browser.wait(`document.querySelector('.terminal-panel .terminal')`);
		await browser.click('button[aria-label="Hide terminal"]');
		await browser.wait(`!document.querySelector('.terminal-panel')`);
	});
});
