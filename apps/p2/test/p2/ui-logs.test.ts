import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Catalog, Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { processLogs } from "../../src/runtime/logs.ts";
import { ServerNatives } from "../../src/runtime/server.ts";
import { Browser, browserTests } from "./browser.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

test(
	"owner Logs sheet filters worker sources, follows live lines, copies the filtered text and restores its locator",
	{ skip: !browserTests, timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture({ web: true });
		t.after(() => fixture.close());
		const browser = await Browser.start();
		t.after(() => browser.close());
		await browser.metrics(1280, 900);
		const worker = `session:logs-worker-${Date.now()}`;
		const other = `session:logs-other-${Date.now()}`;
		processLogs.redactor.addSecret("fixture-private-key");
		processLogs.append(worker, "error", "worker-start-failure fixture-private-key");
		processLogs.append(worker, "event", "worker-ready-marker");
		processLogs.append(other, "event", "other-worker-marker");
		const errors: string[] = [];
		browser.socket.on("message", (raw) => {
			const event = JSON.parse(raw.toString()) as { method?: string; params?: unknown };
			if (event.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(event.params));
		});
		await browser.call("Runtime.enable");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		try {
			await browser.wait(`[...document.querySelectorAll('.foot-button')].some(e=>e.textContent==='Logs')`);
		} catch (error) {
			console.error(await browser.evaluate("document.body.innerText"), errors);
			throw error;
		}
		await browser.evaluate(`[...document.querySelectorAll('.foot-button')].find(e=>e.textContent==='Logs').click()`);
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Logs] #logs-source')`);
		await browser.evaluate(
			`(()=>{const e=document.querySelector('#logs-source');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(worker)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
		);
		await browser.wait(`document.querySelector('.logs-output')?.textContent.includes('worker-start-failure')`);
		const visible = await browser.evaluate<string>("document.querySelector('.logs-output').textContent");
		assert(!visible.includes("other-worker-marker"));
		assert(!visible.includes("fixture-private-key"));
		await browser.evaluate(
			`(()=>{const e=document.querySelector('input[aria-label="Filter logs"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'failure');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
		);
		await browser.wait(
			`document.querySelector('.logs-output') && !document.querySelector('.logs-output').textContent.includes('worker-ready-marker')`,
		);
		processLogs.append(worker, "error", "second-failure live-marker");
		await browser.wait(`document.querySelector('.logs-output')?.textContent.includes('second-failure live-marker')`);
		await browser.evaluate(
			`navigator.clipboard.writeText=async(text)=>{window.logsCopied=text};[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Copy').click()`,
		);
		await browser.wait("window.logsCopied?.includes('second-failure live-marker')");
		assert(!(await browser.evaluate<string>("window.logsCopied")).includes("worker-ready-marker"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`document.querySelector('#logs-source')?.value===${JSON.stringify(worker)}`);
		await browser.wait(`document.querySelector('.logs-output')?.textContent.includes('worker-start-failure')`);
		await browser.click("[role=dialog] button[aria-label=Close]");
		await browser.wait("!document.querySelector('[role=dialog][aria-label=Logs]')");
	},
);

test(
	"failed worker start shows its error, list marker and owner notice; Show logs selects the worker and Retry recovers",
	{ skip: !browserTests, timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture({ web: true });
		t.after(() => fixture.close());
		const client = fixture.browser();
		const session = await (await holdIn(client, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Broken worker fixture",
			},
			BACKGROUND_CONTEXT,
		);
		const status = await holdIn(client, SessionStatus, {}, "reader");
		// A start that is refused: the session's environment is not configured (as a stale catalog would leave it).
		const setEnv = (env: string | null) =>
			fixture.server.host.root(async (ctx) => {
				await (await ctx.get(Catalog, {})).update({ id: session.id, env }, ctx);
			}, BACKGROUND_CONTEXT);
		await setEnv("missing");
		const browser = await Browser.start();
		t.after(() => browser.close());
		await browser.metrics(1280, 900);
		processLogs.append("session:another-worker", "event", "other-worker-only-marker");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
		await browser.wait("document.querySelector('.worker-start-error')?.textContent.includes('not configured')");
		await browser.wait("document.querySelector('.session-worker-error')?.textContent==='Worker failed'");
		await browser.wait("document.querySelector('.owner-notice')?.textContent.includes('not configured')");
		const failed = await until(status.statuses, (value) => Boolean(value?.[session.id]?.error));
		assert.equal(failed?.[session.id]?.running, false);
		const workers = (await fixture.server.host.registry(ServerNatives, BACKGROUND_CONTEXT)).value!.workers;
		const generation = workers.generation(session.id);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.equal(workers.generation(session.id), generation, "failed starts are cached, not repeatedly spawned");
		await browser.evaluate(
			"[...document.querySelectorAll('.worker-start-error button')].find(e=>e.textContent==='Show logs').click()",
		);
		await browser.wait(`document.querySelector('#logs-source')?.value===${JSON.stringify(`session:${session.id}`)}`);
		await browser.wait("document.querySelector('.logs-output')?.textContent.includes('not configured')");
		assert(
			!(await browser.evaluate<string>("document.querySelector('.logs-output').textContent")).includes(
				"other-worker-only-marker",
			),
		);
		await browser.click("[role=dialog] button[aria-label=Close]");
		await setEnv(null);
		await browser.evaluate(
			"[...document.querySelectorAll('.worker-start-error button')].find(e=>e.textContent==='Retry').click()",
		);
		await browser.wait(
			"!document.querySelector('.worker-start-error') && document.querySelector('.composer textarea')",
		);
		await until(
			status.statuses,
			(value) => value?.[session.id]?.running === true && value[session.id].error === undefined,
		);
		await browser.wait("!document.querySelector('.session-worker-error')");
		assert(workers.generation(session.id) > generation);
	},
);
