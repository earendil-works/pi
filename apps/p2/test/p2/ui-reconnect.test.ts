// Live regression: an open tab must recover its handles, not rely on a page reload after a restart.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { clientHost, holdIn, localOwner, poll, until } from "./helpers.ts";

const draft = (text: string) =>
	`(()=>{const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;

describe("an open Chromium tab reconnects after backend downtime", { skip: !browserTests, timeout: 150_000 }, () => {
	let browser: Browser,
		root: string,
		port: number,
		child: ChildProcess | undefined,
		supervisor: number,
		log = "",
		id: string;
	const start = async () => {
		log = "";
		child = spawn("npm", ["run", "dev"], {
			cwd: join(root, "apps/p2"),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PORT: String(port),
				P2_DATA_DIR: join(root, "data"),
				P2_FAKE: "1",
				P2_RADIUS: "0",
				P2_DEV_RESUME: "[]",
			},
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		await poll(() => /p2 dev supervisor: (\d+)/.test(log), 10_000, "own Node supervisor");
		supervisor = Number(/p2 dev supervisor: (\d+)/.exec(log)?.[1]);
		assert(supervisor > 0);
		await poll(() => /p2: http:\/\/127\.0\.0\.1:/.test(log), 30_000, "own dev server ready");
	};
	const stop = async () => {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const closed = once(child, "close");
		process.kill(supervisor, "SIGTERM");
		await closed;
	};
	const recovered = async (text: string) => {
		try {
			await browser.wait(
				`!document.querySelector('.read-only-bar') && !document.querySelector('.offline') && document.querySelector('.composer textarea')`,
			);
			assert.equal(await browser.evaluate<string>("window.reconnectDocument"), "original document");
			assert.equal(await browser.evaluate<string>("document.querySelector('.composer textarea').value"), text);
			assert.match(
				await browser.evaluate<string>("document.querySelector('.messages').textContent"),
				/Echo: restart fixture/,
			);
			await browser.click('button[aria-label="Session options"]');
			await browser.wait(`document.querySelector('[role=dialog][aria-label=Session]')`);
			await browser.click("[role=dialog] button[aria-label=Close]");
			await browser.click("button[aria-label=Send]");
			await browser.wait(
				`document.querySelector('.messages')?.textContent.includes(${JSON.stringify(`Echo: ${text}`)})`,
			);
		} catch (error) {
			console.error(log);
			console.error(
				await browser.evaluate(
					`({text:document.querySelector('.main')?.textContent.slice(-250),opens:window.reconnectOpens})`,
				),
			);
			throw error;
		}
	};
	before(async () => {
		root = mkdtempSync(join(tmpdir(), "p2-reconnect-"));
		mkdirSync(join(root, "workspace"));
		// Copy the app so other dev sessions' saves cannot restart this test's supervisor.
		const project = join(root, "apps/p2");
		await mkdir(join(project, "scripts"), { recursive: true });
		for (const name of ["src", "plugins"])
			await cp(new URL(`../../${name}`, import.meta.url), join(project, name), { recursive: true });
		for (const name of ["package.json", "tsconfig.json"])
			await copyFile(new URL(`../../${name}`, import.meta.url), join(project, name));
		await copyFile(new URL("../../scripts/dev.mjs", import.meta.url), join(project, "scripts/dev.mjs"));
		await symlink(new URL("../../node_modules", import.meta.url).pathname, join(project, "node_modules"));
		for (const name of ["packages", "node_modules", "tsconfig.json", "tsconfig.base.json"])
			await symlink(new URL(`../../../../${name}`, import.meta.url).pathname, join(root, name));
		// Widen the real startup window deterministically: sockets must be captured while plugins load.
		const slow = join(project, "plugins/startup-delay");
		await mkdir(slow);
		await writeFile(
			join(slow, "package.json"),
			JSON.stringify({ name: "startup-delay", private: true, type: "module" }),
		);
		await writeFile(
			join(slow, "server.ts"),
			// An object whose open takes a second: the load waits for it (a facet itself declares synchronously).
			`import { defineFacet, local } from "@p2/app/v1";
const Delay = local("test.startup-delay", { version: 1, params: {}, members: {} });
export default defineFacet((host) => host.serve(Delay, (_params, self) => {
 self.open(() => new Promise((resolve) => setTimeout(() => resolve(null), 1000)), () => {});
 return {};
}));`,
		);
		const listener = createServer();
		listener.listen(0, "127.0.0.1");
		await once(listener, "listening");
		const address = listener.address();
		assert(address && typeof address !== "string");
		port = address.port;
		await new Promise<void>((resolve) => listener.close(() => resolve()));
		await start();
		const owner = await localOwner({ port, dataDir: join(root, "data") });
		const client = clientHost(owner);
		try {
			id = (
				await (
					await holdIn(client, Sessions, {}, "owner")
				).create(
					{
						cwd: join(root, "workspace"),
						title: "Reconnect fixture",
					},
					BACKGROUND_CONTEXT,
				)
			).id;
			const chat = await holdIn(client, Chat, { session: id, conversation: 1 }, "participant");
			await chat.send({ text: "restart fixture", requestId: "seed" }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => JSON.stringify(view?.entries).includes("Echo: restart fixture"));
		} finally {
			await client.close(BACKGROUND_CONTEXT);
		}
		browser = await Browser.start();
		await browser.signIn(owner);
		await browser.metrics(1280, 900);
		// Count the chord WebSocket's opens and the dev notice reads; the sockets themselves remain real.
		await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `
			window.reconnectOpens=0;window.devNoticeReads=0;
			const originalFetch=window.fetch.bind(window);window.fetch=async(url,options)=>{const response=await originalFetch(url,options);if(String(url)==='/__p2_dev' && options?.method!=='POST')window.devNoticeReads++;return response;};
			window.WebSocket=new Proxy(window.WebSocket,{construct(Target,args){
				const socket=Reflect.construct(Target,args);
				if(String(args[0]).endsWith('/chord'))socket.addEventListener('open',()=>window.reconnectOpens++);
				return socket;
			}});
		`,
		});
		await browser.open(`http://127.0.0.1:${port}/s/${id}`);
		await browser.wait(
			`document.querySelector('.messages')?.textContent.includes('Echo: restart fixture')&&!document.querySelector('.read-only-bar')`,
		);
		await browser.evaluate("window.reconnectDocument='original document'");
		await browser.evaluate(draft("unsent supervisor draft"));
	});
	after(async () => {
		await browser?.close();
		await stop();
		if (root) rmSync(root, { recursive: true, force: true });
	});
	it("re-holds state and owner controls after SIGUSR2 to the Node supervisor", async () => {
		process.kill(supervisor, "SIGUSR2");
		await poll(() => log.includes("restarting backend"), 5000, "supervisor restart request");
		await poll(
			() => [...log.matchAll(/p2: http:\/\/127\.0\.0\.1:/g)].length === 2,
			30_000,
			"restarted backend ready",
		);
		await recovered("unsent supervisor draft");
		assert.equal(await browser.evaluate<number>("window.reconnectOpens"), 2);
	});
	it("does not replay a real restart on page load, and remembers a refused reload dismissal", async () => {
		await browser.wait(`document.querySelector('.owner-notice.success')?.textContent.includes('Restarted server')`);
		const event = await browser.evaluate<{ noticeId: string; noticeTime: number }>(
			`fetch('/__p2_dev').then(r=>r.json())`,
		);
		assert(event.noticeId && event.noticeTime > 0);
		await browser.open(`http://127.0.0.1:${port}/s/${id}`);
		await browser.wait(
			`window.devNoticeReads>=2 && document.querySelector('.composer textarea') && !document.querySelector('.read-only-bar')`,
		);
		assert.equal(
			await browser.evaluate<number>(`document.querySelectorAll('.owner-notice.success').length`),
			0,
			"a fresh document already saw the current restart result",
		);
		const plugin = join(root, "apps/p2/plugins/startup-delay/server.ts");
		const valid = await readFile(plugin, "utf8");
		try {
			await writeFile(plugin, `${valid}\nthis is broken TypeScript !!!`);
			await browser.wait(
				`document.querySelector('.owner-notice.pending')?.textContent.includes('1 plugin changed')`,
			);
			await browser.click(".owner-notice.pending button");
			await browser.wait(`document.querySelector('.owner-notice.error')?.textContent.includes('Reload refused')`);
			await browser.open(`http://127.0.0.1:${port}/s/${id}`);
			await browser.wait(
				`window.devNoticeReads>=2 && document.querySelector('.owner-notice.error')?.textContent.includes('Reload refused')`,
			);
			await browser.click('.owner-notice.error button[aria-label="Dismiss owner notice"]');
			await browser.wait(`!document.querySelector('.owner-notice.error')`);
			const failed = await browser.evaluate<{ noticeId: string }>(`fetch('/__p2_dev').then(r=>r.json())`);
			assert.equal(
				await browser.evaluate<string>(
					`localStorage.getItem('pi-owner-notice-dismissed:dev:'+${JSON.stringify(failed.noticeId)})`,
				),
				"1",
			);
			await browser.open(`http://127.0.0.1:${port}/s/${id}`);
			await browser.wait(`window.devNoticeReads>=2 && document.querySelector('.owner-notice.pending')`);
			assert.equal(
				await browser.evaluate<number>(
					`document.querySelectorAll('.owner-notice.error,.owner-notice.success').length`,
				),
				0,
				"dismissed failure stays gone; pending changes still show",
			);
		} finally {
			await writeFile(plugin, valid);
		}
		await browser.evaluate("window.reconnectDocument='original document'");
	});
	it("recovers the same document after the whole server is down for 30 seconds", async () => {
		await browser.evaluate(draft("unsent outage draft"));
		await stop();
		await browser.wait(`document.querySelector('.offline')`);
		await delay(30_000);
		await start();
		await recovered("unsent outage draft");
		assert.equal(await browser.evaluate<number>("window.reconnectOpens"), 2);
	});
});
