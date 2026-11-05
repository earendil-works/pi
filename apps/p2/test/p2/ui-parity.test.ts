// Browser regressions for the reported Pi Mobile port failures. Only isolated fake-provider fixtures are used.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { WebSocket } from "ws";
import { Chat } from "../../plugins/chat/contract.ts";
import { Devices } from "../../plugins/devices/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { browserTests } from "./browser.ts";
import { type Fixture, holdIn, http, poll, startFixture, until } from "./helpers.ts";

const termux = process.env.PREFIX !== undefined;
const chromium =
	process.env.CHROMIUM_BIN ?? (termux ? `${process.env.PREFIX}/lib/chromium/chrome` : "/usr/bin/chromium");

class Browser {
	private socket: WebSocket;
	private next = 0;
	private loaded = new Set<string>();
	private failures: string[] = [];
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	constructor(socket: WebSocket) {
		this.socket = socket;
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString()) as {
				id?: number;
				result?: unknown;
				error?: { message: string };
				method?: string;
				params?: {
					loaderId?: string;
					name?: string;
					errorText?: string;
					blockedReason?: string;
				};
			};
			if (
				message.method === "Page.lifecycleEvent" &&
				message.params?.name === "DOMContentLoaded" &&
				message.params.loaderId
			)
				this.loaded.add(message.params.loaderId);
			if (message.method === "Network.loadingFailed")
				this.failures.push(message.params?.errorText ?? message.params?.blockedReason ?? "network failure");
			if (!message.id) return;
			const request = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) request?.reject(new Error(message.error.message));
			else request?.resolve(message.result);
		});
	}
	call(method: string, params: object = {}): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++this.next;
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}
	async evaluate<T>(expression: string): Promise<T> {
		const result = (await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
			result: { value: T };
			exceptionDetails?: unknown;
		};
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	}
	async wait(expression: string): Promise<void> {
		await poll(() => this.evaluate<boolean>(expression), 30_000, expression);
	}
	async open(url: string): Promise<void> {
		const navigation = (await this.call("Page.navigate", { url })) as { loaderId?: string; errorText?: string };
		assert(!navigation.errorText, "browser navigation failed");
		// Do not let the old document's still-connected DOM satisfy readiness during a reload.
		if (navigation.loaderId) await poll(() => this.loaded.has(navigation.loaderId!), 30_000, "new document loaded");
		try {
			await this.wait(
				'Boolean(document.querySelector(".composer textarea") && !document.querySelector(".offline"))',
			);
		} catch (error) {
			const state = await this.evaluate(
				'({ ready: document.readyState, textareas: document.querySelectorAll("textarea").length, offline: Boolean(document.querySelector(".offline")), title: document.querySelector("h1")?.textContent, hero: document.querySelector(".hero")?.className, dialogs: document.querySelectorAll("[role=dialog]").length, rootChildren: document.querySelector("#root")?.childElementCount })',
			);
			throw new Error(
				`browser readiness failed: ${JSON.stringify(state)}; ${[...new Set(this.failures)].join("; ")}`,
				{
					cause: error,
				},
			);
		}
	}
	async phone(): Promise<void> {
		await this.call("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: true,
		});
	}
	async close(): Promise<void> {
		await this.call("Browser.close");
		this.socket.close();
	}
}

describe("Pi Mobile UI regressions", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let process: ChildProcess;
	let profile: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "visible.txt"), "Workspace listing regression\n");
		profile = mkdtempSync(join(tmpdir(), "p2-chromium-"));
		process = spawn(
			chromium,
			[
				// Termux's Chromium needs its subprocess path; elsewhere (CHROMIUM_BIN may be a wrapper) it must not be set.
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
		const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		browser = new Browser(socket);
		await browser.call("Page.enable");
		await browser.call("Network.enable");
		await browser.call("Page.setLifecycleEventsEnabled", { enabled: true });
		await browser.phone();
	});
	after(async () => {
		await browser?.close().catch(() => {});
		process?.kill("SIGTERM");
		await fixture?.close();
		if (profile) rmSync(profile, { recursive: true, force: true });
	});

	it("opens Providers in the viewport after closing the translated phone drawer", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.evaluate('document.querySelector("button[aria-label=Sessions]").click()');
		await browser.wait('[...document.querySelectorAll("button")].some(button => button.textContent === "Providers")');
		await browser.evaluate(
			'[...document.querySelectorAll("button")].find(button => button.textContent === "Providers").click()',
		);
		await browser.wait('Boolean(document.querySelector("[role=dialog][aria-label=Providers]"))');
		// The sheet starts below the viewport during its slide animation; measure the final layout.
		await browser.wait(
			'[...document.querySelector("[role=dialog]").getAnimations()].every(animation => animation.playState === "finished")',
		);
		const visible = await browser.evaluate<boolean>(
			'(() => { const sheet = document.querySelector("[role=dialog]"); const rect = sheet.getBoundingClientRect(); return !sheet.closest(".drawer") && rect.left >= 0 && rect.right <= 390 && rect.bottom <= 844; })()',
		);
		assert(visible, "the Providers dialog must not be inside the off-screen drawer");
		await browser.evaluate('document.querySelector("[role=dialog] button[aria-label=Close]").click()');
	});

	it("opens Devices and offers a private one-time token to the localhost owner", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.evaluate('document.querySelector("button[aria-label=Sessions]").click()');
		await browser.wait('[...document.querySelectorAll("button")].some(button => button.textContent === "Devices")');
		await browser.evaluate(
			'[...document.querySelectorAll("button")].find(button => button.textContent === "Devices").click()',
		);
		await browser.wait('Boolean(document.querySelector("[role=dialog][aria-label=Devices] #owner-token"))');
		assert(await browser.evaluate<boolean>('/^[a-f0-9]{64}$/.test(document.querySelector("#owner-token").value)'));
		assert(
			await browser.evaluate<boolean>(
				'[...document.querySelectorAll("[role=dialog] button")].some(button => button.textContent.trim() === "Copy token")',
			),
		);
		await browser.evaluate('document.querySelector("[role=dialog] button[aria-label=Close]").click()');
	});

	it("has only the folder cwd button on New session, and applies a directory-picker selection", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		assert.equal(await browser.evaluate<number>('document.querySelectorAll(".hero .cwd-pick").length'), 1);
		assert.equal(await browser.evaluate<number>('document.querySelectorAll(".hero input").length'), 0);
		// Delay only this disposable browser's transport so the loading interaction is deterministic.
		await browser.evaluate(
			`(() => { const send=WebSocket.prototype.send;window.originalPickerSend=send;WebSocket.prototype.send=function(data){setTimeout(()=>send.call(this,data),300)}; })()`,
		);
		await browser.evaluate('document.querySelector(".cwd-pick").click()');
		await browser.wait('Boolean(document.querySelector(".directory-loading"))');
		assert(
			await browser.evaluate<boolean>('document.querySelector("input[aria-label=Directory]").disabled'),
			"the directory input must be disabled while its initial listing loads",
		);
		await browser.evaluate("WebSocket.prototype.send=window.originalPickerSend;delete window.originalPickerSend");
		await browser.wait(
			'Boolean(document.querySelector("input[aria-label=Directory]:not(:disabled)") && document.querySelector(".directory-use:not(:disabled)"))',
		);
		await browser.evaluate(
			`(() => { const input = document.querySelector("input[aria-label=Directory]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(fixture.workspace)}); input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		await browser.evaluate('document.querySelector("input[aria-label=Directory]").form.requestSubmit()');
		await browser.wait(
			`Boolean([...document.querySelectorAll("button")].find(button => button.textContent.trim() === ${JSON.stringify(`Use ${fixture.workspace}`)}))`,
		);
		await browser.evaluate(
			`[...document.querySelectorAll("button")].find(button => button.textContent.trim() === ${JSON.stringify(`Use ${fixture.workspace}`)}).click()`,
		);
		await browser.wait(
			`document.querySelector('.cwd-pick span')?.textContent===${JSON.stringify(fixture.workspace)} && !document.querySelector('[role=dialog]')`,
		);
		assert.equal(
			await browser.evaluate<string>('document.querySelector(".cwd-pick span").textContent'),
			fixture.workspace,
		);
	});

	it("scrolls a long transcript and keeps its last answer above the floating composer", async () => {
		const owner = fixture.browser();
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Long transcript",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send(
			{
				text: Array.from({ length: 180 }, (_, i) => `Paragraph ${i}: scroll regression`).join("\n\n"),
				requestId: "scroll-regression",
			},
			BACKGROUND_CONTEXT,
		);
		await until(chat.view, (view) => Boolean(view?.entries.some((entry) => entry.model?.[0]?.role === "assistant")));
		// The transcript renders only the rows near the viewport: at the bottom, the long answer (the question above
		// it is taller than the viewport and what is rendered around it).
		const readyTranscript = `(() => {
			const scroller=document.querySelector('.main .chat .scroller');
			return Boolean(location.pathname==='/s/${session.id}' && scroller &&
				scroller.querySelector('.messages .assistant')?.textContent.includes('Paragraph 179: scroll regression') &&
				scroller.scrollHeight>scroller.clientHeight*3);
		})()`;
		const atBottom = `(() => { const s=document.querySelector('.main .chat .scroller');return Boolean(s && s.clientHeight>0 && s.scrollHeight-s.clientHeight-s.scrollTop<2); })()`;
		for (const [width, height] of [
			[390, 844],
			[1280, 900],
		]) {
			await browser.call("Emulation.setDeviceMetricsOverride", {
				width,
				height,
				deviceScaleFactor: 1,
				mobile: width === 390,
			});
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
			// DOMContentLoaded/composer readiness is not transcript hydration, especially under suite load.
			await browser.wait(readyTranscript);
			await browser.wait(atBottom);
			const before = await browser.evaluate<{ top: number; x: number; y: number }>(
				'(() => { const s=document.querySelector(".scroller"),r=s.getBoundingClientRect();return {top:s.scrollTop,x:r.left+80,y:r.top+120}; })()',
			);
			await browser.call("Emulation.setTouchEmulationEnabled", { enabled: width === 390 });
			if (width === 390) {
				await browser.call("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ x: before.x, y: before.y }],
				});
				for (let step = 1; step <= 10; step++) {
					await browser.call("Input.dispatchTouchEvent", {
						type: "touchMove",
						touchPoints: [{ x: before.x, y: before.y + step * 30 }],
					});
					await browser.evaluate("new Promise(resolve=>setTimeout(resolve,30))");
				}
				// Lift after stopping: a synthetic fling can otherwise fight the subsequent bottom-button click.
				await browser.evaluate("new Promise(resolve=>setTimeout(resolve,150))");
				await browser.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				await browser.wait(`document.querySelector('.main .chat .scroller')?.scrollTop < ${before.top - 100}`);
				await browser.wait(`Boolean(document.querySelector('button[aria-label="Scroll to bottom"]'))`);
				await browser.evaluate(`document.querySelector('button[aria-label="Scroll to bottom"]').click()`);
				await browser.wait(atBottom);
				before.top = await browser.evaluate<number>('document.querySelector(".scroller").scrollTop');
			}
			await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
			if (width === 390) {
				// A fresh document ends Chromium's synthetic touch scroll sequence before exercising a mouse wheel.
				await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
				await browser.wait(readyTranscript);
				await browser.wait(atBottom);
				before.top = await browser.evaluate<number>('document.querySelector(".scroller").scrollTop');
			}
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: before.x,
				y: before.y,
				deltaX: 0,
				deltaY: -500,
			});
			await browser.wait(`document.querySelector('.main .chat .scroller')?.scrollTop < ${before.top - 100}`);
			await browser.wait(`Boolean(document.querySelector('button[aria-label="Scroll to bottom"]'))`);
			await browser.evaluate(`document.querySelector('button[aria-label="Scroll to bottom"]').click()`);
			await browser.wait(`!document.querySelector('button[aria-label="Scroll to bottom"]')`);
			await browser.wait(atBottom);
			assert(
				await browser.evaluate<boolean>(
					'document.querySelector(".messages").lastElementChild.getBoundingClientRect().bottom <= document.querySelector(".dock").getBoundingClientRect().top + 1',
				),
				"the final answer must not be covered by the composer",
			);
			await browser.evaluate(
				`(() => { const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'slow\\none\\ntwo\\nthree');input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
			);
			await browser.wait(`document.querySelector('.composer textarea')?.clientHeight >= 96`);
			await browser.evaluate(`document.querySelector('.composer').requestSubmit()`);
			await browser.wait(`document.querySelector('.streaming .elanor-markdown')?.textContent.length > 100`);
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: before.x,
				y: before.y,
				deltaX: 0,
				deltaY: -500,
			});
			await browser.wait(`Boolean(document.querySelector('button[aria-label="Scroll to bottom"]'))`);
			// The reader's position is where the answer's start is on screen: an answer growing below the reader moves
			// nothing on screen.
			const answerTop = `document.querySelector('.streaming').closest('.row').getBoundingClientRect().top`;
			await browser.evaluate(
				`(async () => { let previous=${answerTop},stable=0;for(let frame=0;frame<90;frame++){await new Promise(requestAnimationFrame);const next=${answerTop};stable=next===previous?stable+1:0;previous=next;if(stable>=5)return;}throw new Error('Wheel scrolling did not settle');})()`,
			);
			const paused = await browser.evaluate<{ top: number; length: number }>(
				`({top:${answerTop},length:document.querySelector('.streaming .elanor-markdown').textContent.length})`,
			);
			await browser.wait(
				`document.querySelector('.streaming .elanor-markdown')?.textContent.length > ${paused.length + 150}`,
			);
			const after = await browser.evaluate<number>(answerTop);
			assert(
				Math.abs(after - paused.top) < 20,
				`streaming must preserve the reader's position while unfollowed: ${width}px, ${paused.top} -> ${after}`,
			);
			await browser.evaluate(`document.querySelector('button[aria-label="Scroll to bottom"]').click()`);
			await browser.wait(
				`!document.querySelector('.streaming') && !document.querySelector('button[aria-label="Scroll to bottom"]')`,
			);
			await browser.wait(atBottom);
		}
		await browser.phone();
	});

	it("loads workspace files when opened immediately after the chat attaches, including after reload", async () => {
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const session = await sessions.create(
			{ cwd: fixture.workspace, title: "Workspace regression" },
			BACKGROUND_CONTEXT,
		);
		for (let attempt = 0; attempt < 2; attempt++) {
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
			await browser.wait(`Boolean(document.querySelector('button[aria-label="Workspace files and changes"]'))`);
			await browser.evaluate(`document.querySelector('button[aria-label="Workspace files and changes"]').click()`);
			await browser.wait(
				`[...document.querySelectorAll('.workspace-row')].some(button => button.querySelector('.workspace-name')?.textContent === 'visible.txt')`,
			);
			await browser.evaluate(
				`[...document.querySelectorAll('.workspace-row')].find(button => button.querySelector('.workspace-name')?.textContent === 'visible.txt').click()`,
			);
			await browser.wait(
				'document.querySelector(".workspace")?.textContent.includes("Workspace listing regression")',
			);
			await browser.evaluate(`document.querySelector('button[aria-label="Close workspace"]').click()`);
		}
	});

	it("redeems a fragment owner link, removes the token and signs out all devices from the Devices sheet", async () => {
		const { token } = await fixture.browser().hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT);
		const origin = `http://127.0.0.1:${fixture.server.port}`;
		await browser.open(`${origin}/owner#${token}`);
		assert(await browser.evaluate<boolean>('location.pathname === "/" && location.hash === ""'));
		const cookies = (await browser.call("Network.getCookies", { urls: [origin] })) as {
			cookies: { name: string; httpOnly: boolean; sameSite: string }[];
		};
		const cookie = cookies.cookies.find((entry) => entry.name === `p2_owner_${fixture.server.port}`);
		assert(cookie?.httpOnly);
		assert(cookie?.sameSite === "Lax");
		assert.equal(
			(
				await http(fixture.server.port, "/owner/claim", {
					method: "POST",
					headers: { Origin: origin, "Content-Type": "application/json" },
					body: JSON.stringify({ token }),
				})
			).status,
			403,
		);
		await browser.evaluate('document.querySelector("button[aria-label=Sessions]").click()');
		await browser.wait('[...document.querySelectorAll("button")].some(button => button.textContent === "Devices")');
		await browser.evaluate(
			'[...document.querySelectorAll("button")].find(button => button.textContent === "Devices").click()',
		);
		await browser.wait('Boolean(document.querySelector("[role=dialog][aria-label=Devices]"))');
		await browser.wait(
			'document.querySelector("[role=dialog]").textContent.includes("Associated devices cannot mint")',
		);
		assert(await browser.evaluate<boolean>('!document.querySelector("#owner-token")'));
		await browser.evaluate(
			'[...document.querySelectorAll("[role=dialog] button")].find(button => button.textContent.trim() === "Sign out all devices").click()',
		);
		await browser.wait(
			'[...document.querySelectorAll("[role=dialog] button")].some(button => button.textContent.trim() === "Confirm sign out all devices")',
		);
		await browser.evaluate(
			'[...document.querySelectorAll("[role=dialog] button")].find(button => button.textContent.trim() === "Confirm sign out all devices").click()',
		);
		await browser.wait('location.pathname === "/owner" && Boolean(document.querySelector("#sign-in"))');
		const after = (await browser.call("Network.getCookies", { urls: [origin] })) as { cookies: { name: string }[] };
		assert(!after.cookies.some((entry) => entry.name === `p2_owner_${fixture.server.port}`));
	});
});
