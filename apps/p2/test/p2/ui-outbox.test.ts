// Sending never waits for the connection (plugins/chat/outbox.ts): with the page offline the composer stays, a sent
// message shows at once like any other, and it reaches the server exactly once when the page is back online. And a
// conversation opened before shows at once on a page that starts without a connection (src/web/conversation-cache.ts).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Host } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/**
 * The page's WebSockets, with a switch: `__goOffline()` closes them and fails every new one (the app keeps retrying),
 * `__offline = false` lets the next retry through.
 */
const SWITCH = `(() => {
	const Native = WebSocket;
	const sockets = new Set();
	// A page can start offline (a cold start without a connection): set before it loads.
	window.__offline = sessionStorage.getItem("offline") === "1";
	window.WebSocket = class extends Native {
		constructor(url, protocols) {
			// Offline: a path the server refuses, which closes at once as an unreachable server does.
			super(window.__offline ? String(url).replace("/chord", "/offline") : url, protocols);
			sockets.add(this);
			this.addEventListener("close", () => sockets.delete(this));
		}
	};
	window.__goOffline = () => {
		window.__offline = true;
		for (const socket of sockets) socket.close();
	};
})()`;
const draft = (text: string) =>
	`(()=>{const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
/** How many people's messages end with `text`. */
const bubbles = (text: string) =>
	`[...document.querySelectorAll('.messages .user .bubble')].filter((e) => e.textContent.trim().endsWith(${JSON.stringify(text)})).length`;
const inputs = (view: ConversationView | null | undefined, text: string) =>
	(view?.entries ?? []).filter((entry) => entry.kind === "p2.input" && JSON.stringify(entry.data).includes(text))
		.length;

describe("offline in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	before(async () => {
		fixture = await startFixture({ web: true });
		owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: SWITCH });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("keeps the composer, shows the message at once, and delivers it once back online", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Offline",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await browser.metrics(390, 844);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
			await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);

			await browser.evaluate("window.__goOffline()");
			await browser.wait(`Boolean(document.querySelector('.offline'))`);
			// The composer stays (no "Connecting…" bar): the page still knows it is the owner.
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.composer textarea'))`));
			const text = "hello while offline";
			await browser.evaluate(draft(text));
			await browser.click("button[aria-label=Send]");
			// It leaves the composer and shows at once, as any message does; the server does not have it yet.
			await browser.wait(`document.querySelector('.composer textarea').value === '' && ${bubbles(text)} === 1`);
			assert.equal(inputs(chat.view.value, text), 0);

			await browser.evaluate("window.__offline = false");
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`), 60_000);
			await browser.wait(`!document.querySelector('.offline') && ${bubbles(text)} === 1`);
			assert.equal(inputs(chat.view.value, text), 1, "delivered once");
			assert.equal(await browser.evaluate<number>(bubbles(text)), 1, "shown once");
		} finally {
			stop();
			chat.release();
		}
	});

	it("lets messages that arrived while offline fade in one after another, and nothing when opening", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Arrivals",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await chat.send({ text: "first", requestId: "a1" }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: first"), 30_000);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
			// Every row the transcript adds, with whether it arrives (animates) and its delay.
			await browser.evaluate(`(() => {
				window.__added = [];
				const record = (row) => window.__added.push({ text: row.textContent.trim().slice(0, 40), arriving: row.classList.contains("arriving"), delay: row.style.animationDelay });
				window.__glides = 0;
				new MutationObserver((changes) => {
					for (const change of changes) for (const node of change.addedNodes) if (node.classList?.contains("row")) record(node);
					// The transcript glides up to make room instead of jumping (a transform animation on .messages).
					const glide = document.querySelector(".messages")?.getAnimations().some((animation) => animation.effect?.getKeyframes().some((frame) => String(frame.transform).includes("translateY")));
					if (glide) window.__glides++;
				}).observe(document.body, { childList: true, subtree: true });
				for (const row of document.querySelectorAll(".row")) record(row);
			})()`);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: first')`);
			assert.deepEqual(
				await browser.evaluate<unknown[]>("window.__added.filter((row) => row.arriving)"),
				[],
				"opening animates nothing",
			);
			assert.equal(await browser.evaluate<number>("window.__glides"), 0, "opening glides nothing");
			// Offline while two more turns happen elsewhere.
			await browser.evaluate("window.__goOffline()");
			await browser.wait(`Boolean(document.querySelector('.offline'))`);
			for (const text of ["second", "third"]) {
				await chat.send({ text, requestId: text }, BACKGROUND_CONTEXT);
				await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes(`Echo: ${text}`), 30_000);
			}
			await browser.evaluate("window.__offline = false");
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: third')`);
			const arrived = await browser.evaluate<{ text: string; arriving: boolean; delay: string }[]>(
				"window.__added.filter((row) => row.arriving)",
			);
			for (const text of ["second", "Echo: second", "third", "Echo: third"])
				assert.ok(
					arrived.some((row) => row.text.includes(text)),
					`${text} arrived: ${JSON.stringify(arrived)}`,
				);
			assert.equal(arrived.length, 4, JSON.stringify(arrived));
			assert.ok((await browser.evaluate<number>("window.__glides")) > 0, "the transcript glides up to make room");
			// One after another: increasing delays.
			const delays = arrived.map((row) => Number.parseFloat(row.delay || "0"));
			assert.deepEqual(
				delays,
				[...delays].sort((a, b) => a - b),
			);
			assert.ok(delays.at(-1)! > 0);
		} finally {
			stop();
			chat.release();
		}
	});

	it("forgets what this device kept of sessions the server no longer has", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Still here",
			},
			BACKGROUND_CONTEXT,
		);
		const page = `http://127.0.0.1:${fixture.server.port}/s/${session.id}`;
		const keys = `new Promise((resolve) => { const open = indexedDB.open("p2-conversations"); open.onsuccess = () => { const all = open.result.transaction("kept").objectStore("kept").getAllKeys(); all.onsuccess = () => resolve(all.result); }; })`;
		await browser.open(page);
		await browser.wait(`document.querySelector('.composer textarea')`);
		// A conversation kept for a session the server does not have (deleted, or the data restored from a backup).
		const gone = "00000000-0000-4000-8000-000000000000#1";
		// Written and read back in one transaction: the open page may forget it right after (what this test checks).
		const written = await browser.evaluate<string[]>(
			`new Promise((resolve) => { const open = indexedDB.open("p2-conversations"); open.onsuccess = () => { const tx = open.result.transaction("kept", "readwrite"); const store = tx.objectStore("kept"); store.put({ key: ${JSON.stringify(gone)}, savedAt: Date.now(), view: { entries: [], docs: {} }, history: undefined, sizes: [] }); const all = store.getAllKeys(); tx.oncomplete = () => resolve(all.result); }; })`,
		);
		assert.ok(written.includes(gone));
		await browser.open(page);
		await browser.wait(
			`${keys}.then((all) => !all.includes(${JSON.stringify(gone)}) && all.includes(${JSON.stringify(`${session.id}#1`)}))`,
		);
	});

	it("shows a conversation kept on the device at once on a page that starts offline", async () => {
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{
				cwd: fixture.workspace,
				title: "Kept",
			},
			BACKGROUND_CONTEXT,
		);
		const chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
		const stop = follow(chat.view, () => {});
		try {
			await chat.send({ text: "remember me", requestId: "kept" }, BACKGROUND_CONTEXT);
			await until(chat.view, (view) => JSON.stringify(view?.entries ?? []).includes("Echo: remember me"), 30_000);
			const page = `http://127.0.0.1:${fixture.server.port}/s/${session.id}`;
			await browser.open(page);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: remember me')`);
			// Kept a second after it settles.
			await new Promise((resolve) => setTimeout(resolve, 1_500));

			// A cold start without a connection: the conversation and the composer are there before anything arrives.
			await browser.evaluate(`sessionStorage.setItem("offline", "1")`);
			await browser.open(page);
			await browser.wait(`Boolean(document.querySelector('.offline'))`);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: remember me')`);
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.composer textarea'))`));
			assert.equal(await browser.evaluate<number>(bubbles("remember me")), 1);
			// The context bar's space is there before its numbers: the composer area keeps its height when they come.
			assert.ok(await browser.evaluate<boolean>(`Boolean(document.querySelector('.context-usage.pending'))`));
			const dock = await browser.evaluate<number>(`document.querySelector('.dock').getBoundingClientRect().height`);

			// Back online, the live view takes over: the same conversation, once.
			await browser.evaluate(`sessionStorage.removeItem("offline"); window.__offline = false`);
			await browser.wait(`!document.querySelector('.offline')`);
			await browser.wait(`Boolean(document.querySelector('.context-usage:not(.pending)'))`);
			assert.equal(
				await browser.evaluate<number>(`document.querySelector('.dock').getBoundingClientRect().height`),
				dock,
			);
			await browser.wait(`document.querySelector('.messages')?.textContent.includes('Echo: remember me')`);
			assert.equal(await browser.evaluate<number>(bubbles("remember me")), 1);
		} finally {
			stop();
			chat.release();
		}
	});
});
