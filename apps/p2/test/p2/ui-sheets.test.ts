// Real browser regressions for provider navigation and inline remote-share confirmation.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Envs } from "../../plugins/envs/contract.ts";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import { Catalog } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { ServerResourceOptions } from "../../src/runtime/server.ts";
import { browserTests } from "./browser.ts";
import { type Fixture, poll, startFixture, until } from "./helpers.ts";

const termux = process.env.PREFIX !== undefined;
const chromium =
	process.env.CHROMIUM_BIN ?? (termux ? `${process.env.PREFIX}/lib/chromium/chrome` : "/usr/bin/chromium");
const fixtureModels: NonNullable<ServerResourceOptions["createModels"]> = (credentials, modelsStore) => {
	const models = createModels({ credentials, modelsStore });
	const faux = fauxProvider({ api: "ui-login" });
	models.setProvider({
		...faux.provider,
		getModels: () => faux.models,
		auth: {
			apiKey: {
				name: "Fixture key",
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "Enter fixture key" }),
				}),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
	});
	return models;
};

describe("sheet parity", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let process: ChildProcess;
	let profile: string;
	let socket: WebSocket;
	let id = 0;
	const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	const call = (method: string, params: object = {}): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const next = ++id;
			pending.set(next, { resolve, reject });
			socket.send(JSON.stringify({ id: next, method, params }));
		});
	const evaluate = async <T>(expression: string): Promise<T> => {
		const response = (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
			result: { value: T };
			exceptionDetails?: unknown;
		};
		if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
		return response.result.value;
	};
	const wait = (expression: string) => poll(() => evaluate<boolean>(`Boolean(${expression})`), 30_000, expression);
	const click = async (text: string) => {
		const selector = `[...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
		await wait(selector);
		await evaluate(`${selector}.click()`);
	};
	const openProviders = async () => {
		await evaluate(`document.querySelector('button[aria-label=Sessions]').click()`);
		await wait(`[...document.querySelectorAll('button')].some(e=>e.textContent==='Providers')`);
		await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='Providers').click()`);
		await wait(`document.querySelector('[role=dialog][aria-label=Providers] .row-button')`);
		await evaluate(`document.querySelector('[role=dialog] .row-button').click()`);
		await wait(`document.querySelector('.provider-detail')`);
	};
	before(async () => {
		fixture = await startFixture({ web: true, resources: { createModels: fixtureModels } });
		profile = mkdtempSync(join(tmpdir(), "p2-sheet-browser-"));
		process = spawn(
			chromium,
			[
				...(termux ? [`--browser-subprocess-path=${chromium}`] : []),
				"--headless=new",
				"--no-sandbox",
				"--no-zygote",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		await poll(() => existsSync(join(profile, "DevToolsActivePort")), 20_000, "Chromium debugging port");
		const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
		const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { webSocketDebuggerUrl: string }[];
		socket = new WebSocket(pages[0].webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: { message: string } };
			if (!message.id) return;
			const request = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) request?.reject(new Error(message.error.message));
			else request?.resolve(message.result);
		});
		await call("Page.enable");
		await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
		await call("Page.navigate", { url: `http://127.0.0.1:${fixture.server.port}/` });
		await wait(`document.querySelector('textarea') && !document.querySelector('.offline')`);
	});
	after(async () => {
		await call("Browser.close").catch(() => {});
		socket?.close();
		process?.kill("SIGTERM");
		await fixture?.close();
		if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("Done returns to All providers, and Back cancels and dismisses an unfinished provider flow", async () => {
		const login = fixture.browser().hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		const stop = follow(login.login, () => {});
		try {
			await openProviders();
			await click("Fixture key");
			await wait(`document.querySelector('#login-value')`);
			await evaluate(
				`(() => { const input=document.querySelector('#login-value'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'fixture-only'); input.dispatchEvent(new Event('input', { bubbles:true })); })()`,
			);
			await evaluate(`document.querySelector('#login-value').form.requestSubmit()`);
			await until(login.login, (state) => state?.status === "success");
			await click("Done");
			await wait(`document.querySelector('[role=dialog][aria-label=Providers] .row-button')`);
			await until(login.login, (state) => state === null);
			// Done went back onto the list's own history entry (the provider screen replaced the list's layer, as in Pi
			// Mobile): one more Back closes the sheet instead of showing an identical list.
			await evaluate("history.back()");
			await wait(`!document.querySelector('[role=dialog][aria-label=Providers]')`);
			await evaluate(`document.querySelector('button[aria-label=Sessions]').click()`);
			await wait(`[...document.querySelectorAll('button')].some(e=>e.textContent==='Providers')`);
			await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='Providers').click()`);
			await wait(`document.querySelector('[role=dialog][aria-label=Providers] .row-button')`);
			await evaluate(`document.querySelector('[role=dialog] .row-button').click()`);
			await click("Fixture key");
			await until(login.login, (state) => state?.status === "working" && state.prompt !== null);
			await evaluate("history.back()");
			await wait(`document.querySelector('[role=dialog][aria-label=Providers] .row-button')`);
			await until(login.login, (state) => state === null);
			await evaluate(`document.querySelector('[role=dialog] .row-button').click()`);
			await click("Fixture key");
			await until(login.login, (state) => state?.status === "working" && state.prompt !== null);
			await evaluate(`document.querySelector('[role=dialog] button[aria-label=Close]').click()`);
			await until(login.login, (state) => state === null);
		} finally {
			stop();
			login.release();
		}
	});

	it("keeps User and Port side by side and uses inline environment deletion with Cancel", async () => {
		await call("Emulation.setDeviceMetricsOverride", {
			width: 1280,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent==='Envs').click()`);
		await wait(`document.querySelector('[role=dialog][aria-label=Environments] .empty-note')`);
		await click("Add environment");
		await wait(`document.querySelector('.env-form')`);
		await wait(
			`[...document.querySelector('[role=dialog]').getAnimations()].every(animation=>animation.playState==='finished')`,
		);
		const layout = await evaluate<{ sameRow: boolean; portWidth: number }>(
			`(() => { const fields=[...document.querySelectorAll('.env-row > .field')];const a=fields[0].getBoundingClientRect(),b=fields[1].getBoundingClientRect();return {sameRow:a.top===b.top,portWidth:b.width}; })()`,
		);
		assert.equal(layout.sameRow, true);
		const expected = await evaluate<number>("parseFloat(getComputedStyle(document.documentElement).fontSize) * 6");
		assert(Math.abs(layout.portWidth - expected) < 0.01);
		await evaluate(
			`(() => { for(const [selector,value] of [['input[placeholder=gpu]','editor'],['input[placeholder=gpu-box]','fixture.invalid']]) { const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true})); } })()`,
		);
		await evaluate(`document.querySelector('.env-form').requestSubmit()`);
		await wait(`document.querySelector('[role=dialog][aria-label=editor]')`);
		await click("← All environments");
		await wait(`document.querySelector('[role=dialog][aria-label=Environments] .row-button')`);
		await evaluate(`document.querySelector('[role=dialog] .row-button').click()`);
		await click("Delete environment");
		await wait(`document.querySelector('[role=dialog]')?.textContent.includes('Delete "editor"?')`);
		await click("Cancel");
		await click("Delete environment");
		await click("Delete");
		await wait(`document.querySelector('[role=dialog][aria-label=Environments] .empty-note')`);
		await evaluate(`document.querySelector('[role=dialog] button[aria-label=Close]').click()`);
		await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	});

	it("asks inline before creating a remote read/write link, but not when copying or resetting an existing one", async () => {
		const owner = fixture.browser();
		await owner
			.hold(Envs, {}, BACKGROUND_CONTEXT)
			.save({ name: "remote", config: { type: "ssh", host: "unreachable.invalid" } }, BACKGROUND_CONTEXT);
		// Seed metadata directly: this UI-only test never needs a real SSH connection.
		const session = await fixture.server.host.root(
			async (ctx) =>
				(await ctx.get(Catalog, {})).create(
					{
						cwd: "/tmp",
						env: "remote",
						title: "Remote share",
						model: { provider: "faux", modelId: "faux-1" },
						thinkingLevel: "off",
					},
					ctx,
				),
			BACKGROUND_CONTEXT,
		);
		const sharing = owner.hold(Sharing, { session: session.id }, BACKGROUND_CONTEXT);
		const stop = follow(sharing.links, () => {});
		try {
			await call("Page.navigate", { url: `http://127.0.0.1:${fixture.server.port}/s/${session.id}` });
			await wait(`document.querySelector('button[aria-label="Session options"]')`);
			await evaluate(
				`window.confirm=()=>{throw new Error('Sharing must use an inline confirmation')}; document.querySelector('button[aria-label="Session options"]').click();`,
			);
			await wait(`document.querySelector('[role=dialog][aria-label=Session] .row-button')`);
			await evaluate(`document.querySelector('[role=dialog][aria-label=Session] .row-button').click()`);
			await wait(`document.querySelector('[role=dialog][aria-label=Share] .share-row .button:not(:disabled)')`);
			await evaluate(`document.querySelectorAll('.share-row')[1].querySelector('.button').click()`);
			await wait(
				`document.querySelector('[role=dialog]')?.textContent.includes('Guests can run commands on "remote". Create the link?')`,
			);
			assert.equal((await until(sharing.links, (links) => links !== undefined))?.length, 0);
			await click("Cancel");
			await evaluate(`document.querySelectorAll('.share-row')[1].querySelector('.button').click()`);
			await click("Create");
			await until(sharing.links, (links) => Boolean(links?.some((link) => link.mode === "full")));
			await wait(`document.querySelectorAll('.share-row')[1]?.textContent.includes('Reset')`);
			await evaluate(`document.querySelectorAll('.share-row')[1].querySelector('.button').click()`);
			assert(
				await evaluate<boolean>(
					`(() => { const dialog=document.querySelector('[role=dialog][aria-label=Share]');return Boolean(dialog && !dialog.textContent.includes('Create the link?')); })()`,
				),
			);
			await click("Reset");
			await wait(
				`document.querySelector('[role=dialog]')?.textContent.includes('New link, disconnect its guests?')`,
			);
			const previous = sharing.links.value?.find((link) => link.mode === "full")?.token;
			await click("Reset");
			await until(sharing.links, (links) =>
				Boolean(links?.some((link) => link.mode === "full" && link.token !== previous)),
			);
			await evaluate(`document.querySelector('[role=dialog] button[aria-label=Close]').click()`);
		} finally {
			stop();
			sharing.release();
		}
	});
});
