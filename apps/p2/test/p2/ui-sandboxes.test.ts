// Real browser checks of the sandbox UI: the Envs list and sandbox form, the top bar's and the sidebar folder's lock and
// the confirmation before a session moves out of its sandbox. No SSH host is reachable: VM states read as unknown, listings fail.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Envs } from "../../plugins/envs/contract.ts";
import type { EnvConfig } from "../../plugins/envs/schema.ts";
import { Catalog } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, startFixture } from "./helpers.ts";

const input = (selector: string, value: string) =>
	`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
const button = (text: string) =>
	`[...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;

describe("sandbox UI", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser;
	const press = async (text: string) => {
		await browser.wait(button(text));
		await browser.evaluate(`${button(text)}.click()`);
	};
	before(async () => {
		fixture = await startFixture({ web: true });
		const envs = fixture.browser().hold(Envs, {}, BACKGROUND_CONTEXT);
		await envs.save({ name: "host1", config: { type: "ssh", host: "unreachable.invalid" } }, BACKGROUND_CONTEXT);
		await envs.save(
			{
				name: "box1",
				config: { type: "gondolin", host: "host1", mounts: [{ host: "~/src", guest: "/workspace" }] },
			},
			BACKGROUND_CONTEXT,
		);
		envs.release();
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(1280, 900);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("lists a sandbox under its host and edits its folders and allowed hosts", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`document.querySelector('textarea') && !document.querySelector('.offline')`);
		await browser.openSettings("Environments");
		await browser.wait(`document.querySelector('[role=dialog] [aria-label=Environments] .env-sandbox svg')`);
		const rows = await browser.evaluate<string[]>(
			`[...document.querySelectorAll('[role=dialog] .env-group .row-button')].map(e=>e.textContent)`,
		);
		assert.match(rows[0]!, /^host1/);
		assert.match(rows[1]!, /box1.*0 sessions/);
		// The host was never tested: nothing says it can run sandboxes, so no "Add sandbox on" row.
		assert.equal(rows.length, 2);
		// Reading the VM's state fails without the host: unknown, not a blocked list.
		await browser.wait(`document.querySelector('.env-sandbox .vm-dot.unknown')`);

		await browser.evaluate(`document.querySelector('[role=dialog] .env-sandbox').click()`);
		await browser.wait(`document.querySelector('[role=dialog] [aria-label=box1] .env-form select')`);
		assert.equal(await browser.evaluate<string>(`document.querySelector('.env-form select').value`), "host1");
		await browser.wait(`document.querySelector('[role=dialog]').textContent.includes('VM state unknown')`);
		assert(
			await browser.evaluate<boolean>(
				`document.querySelector('.sandbox-folder').textContent.includes('~/src → /workspace')`,
			),
		);
		await press("+ Add folder");
		await browser.evaluate(input("input[placeholder='~/project']", "/data"));
		await browser.evaluate(input("input[placeholder='/workspace']", "/data"));
		await browser.evaluate(`document.querySelector('.sandbox-folders input[type=checkbox]').click()`);
		await press("Add folder");
		await browser.evaluate(input(".env-form textarea", "github.com\n*.npmjs.org\n"));
		await browser.evaluate(input("input[placeholder='2']", "4"));
		await browser.evaluate(`document.querySelector('.env-form').requestSubmit()`);
		const envs = fixture.browser().hold(Envs, {}, BACKGROUND_CONTEXT);
		try {
			let config: EnvConfig | undefined;
			for (let attempt = 0; attempt < 100; attempt++) {
				config = (await envs.list(BACKGROUND_CONTEXT)).find((env) => env.name === "box1")?.config;
				if (config?.type === "gondolin" && config.cpus !== undefined) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.deepEqual(config, {
				type: "gondolin",
				host: "host1",
				mounts: [
					{ host: "~/src", guest: "/workspace" },
					{ host: "/data", guest: "/data", readonly: true },
				],
				allowHosts: ["github.com", "*.npmjs.org"],
				cpus: 4,
			});
		} finally {
			envs.release();
		}
		await press("← All environments");
		await browser.wait(`document.querySelector('[role=dialog] .env-group > .row-button')`);
		await browser.evaluate(`document.querySelector('[role=dialog] .env-group > .row-button').click()`);
		await browser.wait(`document.querySelector('[role=dialog]').textContent.includes('Sandboxes on host1')`);
		await press("Add sandbox");
		await browser.wait(`document.querySelector('[role=dialog] [aria-label="New sandbox"] .env-form select')`);
		assert.equal(await browser.evaluate<string>(`document.querySelector('.env-form select').value`), "host1");
		await browser.evaluate(`document.querySelector('[role=dialog] button[aria-label=Close]').click()`);
	});

	it("locks a sandboxed session's location and confirms moving it out", async () => {
		const session = await fixture.server.host.root(
			async (ctx) =>
				(await ctx.get(Catalog, {})).create(
					{
						cwd: "/workspace",
						env: "box1",
						title: "Sandboxed",
						model: { provider: "faux", modelId: "faux-1" },
						thinkingLevel: "off",
					},
					ctx,
				),
			BACKGROUND_CONTEXT,
		);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
		await browser.wait(`document.querySelector('.title-cwd .title-lock')`);
		// Its folder in the sidebar shows a lock instead of a folder.
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-group')].some(g=>g.querySelector('.group-link').title==='box1:/workspace' && g.querySelector('.nav-marker svg[aria-label=Sandbox]'))`,
		);
		await browser.evaluate(`document.querySelector('.title-cwd').click()`);
		await browser.wait(`document.querySelector('[role=dialog][aria-label="Working directory"] select')`);
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('[role=dialog] optgroup[label=Sandboxes] option')].map(e=>e.textContent)`,
			),
			["box1 · sandbox on host1"],
		);
		assert(
			await browser.evaluate<boolean>(
				`document.querySelector('[role=dialog]').textContent.includes("run in the box1 VM and can't leave it")`,
			),
		);
		await browser.evaluate(
			`(()=>{const s=document.querySelector('[role=dialog] select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'');s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
		);
		await browser.wait(`document.querySelector('.directory-use')?.textContent.startsWith('Move session to')`);
		await browser.evaluate(`document.querySelector('.directory-use').click()`);
		await browser.wait(`document.querySelector('[role=dialog]').textContent.includes('Leave sandbox box1?')`);
		assert(
			await browser.evaluate<boolean>(
				`document.querySelector('.directory-leave').textContent.includes('run directly on this device')`,
			),
		);
		await press("Cancel");
		await browser.wait(`document.querySelector('.directory-use') && !document.querySelector('.directory-leave')`);
		await browser.evaluate(`document.querySelector('[role=dialog] button[aria-label=Close]').click()`);
	});
});
