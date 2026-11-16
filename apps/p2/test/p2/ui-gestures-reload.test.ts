// Phone gestures with touch, before and after a live plugin reload (dev mode, as the owner's phone runs p2): the drawer
// opens with a swipe on the chat and closes with one on the drawer (drawer-swipe.ts), a drag on a settled wheel rolls
// it through its steps (elanor-extra/ticker.tsx, drum.ts), and the activity sheet closes when its top edge is swiped
// down (sheet-swipe.ts). A reload replaces the objects the page holds, or the page itself when web code changed; a
// reloaded page may restore a route whose open sheet its new code no longer shows. Every gesture must work after each.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const center = (selector: string) =>
	`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;
const sheet = "document.querySelector('[data-testid=activity-sheet]')";

describe("phone gestures across a live plugin reload", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, session: string;
	before(async () => {
		fixture = await startFixture({ web: true, dev: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Gestures" }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		// Two calls with thinking between them on one wheel: a settled wheel has steps to roll to.
		await chat.send({ text: "steps", requestId: "steps" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => !live(view)?.run && JSON.stringify(view).includes("Echo: steps"), 30_000);
		chat.release();
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	const touch = (type: string, x?: number, y?: number) =>
		browser.call("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y }] });
	/** A drag from (x0, y0) to (x1, y1) in `steps` moves 16 ms apart. */
	const drag = async (x0: number, y0: number, x1: number, y1: number, steps = 12) => {
		await touch("touchStart", x0, y0);
		for (let step = 1; step <= steps; step++) {
			await touch("touchMove", x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps);
			await sleep(16);
		}
		await touch("touchEnd");
	};
	const tap = async (selector: string) => {
		const { x, y } = await browser.evaluate<{ x: number; y: number }>(center(selector));
		await touch("touchStart", x, y);
		await touch("touchEnd");
	};

	/** Every gesture, on the page as it is now. */
	const gestures = async (when: string) => {
		await browser.wait(
			"document.querySelector('[data-testid=activity][data-state=done]') && !document.querySelector('.offline')",
		);
		await sleep(300);
		// The drawer: a swipe toward the inline end on the chat opens it, one back on the drawer closes it.
		await drag(60, 400, 330, 400);
		await browser
			.wait("document.querySelector('.app.drawer-open') && !document.querySelector('.drawer').style.transform")
			.catch(() => assert.fail(`${when}: the swipe opens the drawer`));
		await drag(300, 400, 20, 400);
		await browser
			.wait("!document.querySelector('.app.drawer-open') && !document.querySelector('.drawer').style.transform")
			.catch(() => assert.fail(`${when}: the swipe closes the drawer`));
		// The wheel: a drag down on a settled wheel rolls it back toward its first step, a drag up toward its summary.
		const face = "document.querySelector('[data-testid=activity] .el-ticker-item[data-current]')?.textContent";
		const first = await browser.evaluate<boolean>(
			"document.querySelector('[data-testid=activity] .el-ticker-item')?.dataset.current === 'true'",
		);
		const before = await browser.evaluate<string>(face);
		const wheel = await browser.evaluate<{ x: number; y: number }>(center("[data-testid=activity] .el-ticker"));
		const reach = first ? -70 : 70;
		await drag(wheel.x, wheel.y - Math.sign(reach) * 10, wheel.x, wheel.y + reach, 10);
		await browser
			.wait(`${face} !== ${JSON.stringify(before)}`)
			.catch(() => assert.fail(`${when}: the drag rolls the wheel`));
		// The sheet: a tap on the wheel opens the run's steps, a swipe down on its top edge closes it.
		await sleep(2500);
		await tap("[data-testid=activity] .el-ticker");
		await browser.wait(sheet).catch(() => assert.fail(`${when}: a tap on the wheel opens its sheet`));
		await sleep(500);
		const head = await browser.evaluate<{ x: number; y: number }>(center(".sheet-head h2"));
		await drag(head.x, head.y, head.x, head.y + 500, 10);
		await browser.wait(`!${sheet}`).catch(() => assert.fail(`${when}: the swipe down closes the sheet`));
	};

	it("follow the finger before and after a reload, with the page kept and with a new page", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await gestures("before the reload");

		// A live reload of the plugins the page shows: their objects are replaced, the web bundle stays.
		const version = await browser.evaluate<string>("document.documentElement.dataset.webVersion");
		await fixture.server.reload(["chat", "sessions", "models"]);
		await sleep(6_000);
		assert.equal(await browser.evaluate<string>("document.documentElement.dataset.webVersion"), version);
		await gestures("after the plugin reload");

		// The server's base code changed (answered here by CDP): the page asks the base at its reconnect, finds
		// another one and loads the new page. Its link drops while the network is off.
		await browser.evaluate("(window.__before = true)");
		const changed = (raw: unknown) => {
			const message = JSON.parse(String(raw)) as { method?: string; params?: { requestId: string } };
			if (message.method !== "Fetch.requestPaused" || !message.params) return;
			void browser.call("Fetch.fulfillRequest", {
				requestId: message.params.requestId,
				responseCode: 200,
				responseHeaders: [{ name: "Content-Type", value: "application/json" }],
				body: Buffer.from(JSON.stringify("changed")).toString("base64"),
			});
		};
		browser.socket.on("message", changed);
		await browser.call("Fetch.enable", { patterns: [{ urlPattern: "*/_chord/web/base" }] });
		try {
			await browser.call("Network.enable");
			await browser.call("Network.emulateNetworkConditions", {
				offline: true,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1,
			});
			await browser.wait("document.querySelector('.offline')");
			await browser.call("Network.emulateNetworkConditions", {
				offline: false,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1,
			});
			await browser.wait("!window.__before && document.querySelector('.app')");
		} finally {
			await browser.call("Fetch.disable");
			browser.socket.off("message", changed);
		}
		await gestures("after the page picked up new code");
	});

	it("follow the finger when the reloaded page no longer shows the sheet that was open", async () => {
		const settings = join(fixture.dataDir, "settings.json");
		const base = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
		// The run's sheet open at detail 3, then a page reload into code that keys the turn's rows differently (detail 2
		// here; a new version of the code in the owner's case): the restored layer names a row the page no longer has.
		writeFileSync(settings, JSON.stringify({ ...base, detail: 3 }));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait("document.querySelector('[data-testid=activity][data-state=done]')");
		await sleep(2500);
		await tap("[data-testid=activity] .el-ticker");
		await browser.wait(sheet);
		writeFileSync(settings, JSON.stringify(base));
		await browser.evaluate("location.reload()");
		await browser.wait("document.querySelector('[data-testid=activity][data-state=done]')");
		// Nothing shows the layer: the drawer does not wait for it, and it leaves the route (Back stays one step).
		assert.equal(await browser.evaluate<boolean>(`!${sheet}`), true);
		await gestures("after a reload that dropped the open sheet's row");
		await browser.wait("history.state?.route?.layers?.length === 0");
	});
});
