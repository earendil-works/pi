// Haptics in the browser, through a stand-in for the iOS app's Capacitor bridge: a light tap when a message is sent,
// and a very slight tick at each detent of the activity wheel, as new steps roll in and as the reader rolls it.
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
/** The iOS app's bridge as the page sees it, recording the Haptics calls. */
const BRIDGE = `window.__haptics = []; window.Capacitor = { getPlatform: () => "ios", nativePromise: (plugin, method, options) => { if (plugin === "Haptics") window.__haptics.push(method + (options?.style ? ":" + options.style : "")); return Promise.resolve(); } };`;
const SCRIPT = [
	'await tools.bash({ command: "echo one" });',
	'await tools.bash({ command: "echo two" });',
	'await tools.bash({ command: "echo three" });',
	"return 3;",
].join("\n");

describe("haptics", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, session: string;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Haptics" }, BACKGROUND_CONTEXT)
		).id;
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: BRIDGE });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("taps on send and ticks as the wheel turns, by itself and by the reader", async () => {
		// Everything on the wheel (detail 1): the script's note, its call and the thinking roll in, then the summary.
		const settings = join(fixture.dataDir, "settings.json");
		writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), detail: 1 }));
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
		await browser.wait("document.querySelector('textarea[aria-label=Message]')");
		await browser.evaluate(`(() => {
			const box = document.querySelector('textarea[aria-label=Message]');
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(`codemode ${SCRIPT}`)});
			box.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
		await browser.click("button[aria-label=Send]");
		const chat = await holdIn(fixture.browser(), Chat, { session, conversation: 1 }, "participant");
		await until(chat.view, (view) => !live(view)?.run && JSON.stringify(view).includes("Echo: codemode"), 30_000);
		chat.release();
		await browser.wait("document.querySelector('[data-testid=activity][data-state=done]')");
		// The send's tap, then the selection generator prepared once and a tick per step rolling in.
		const rolled = await browser.evaluate<string[]>("window.__haptics");
		assert.equal(rolled[0], "impact:LIGHT");
		assert.equal(rolled.filter((call) => call === "selectionStart").length, 1);
		assert.ok(rolled.filter((call) => call === "selectionChanged").length >= 2, JSON.stringify(rolled));
		// The reader rolls the wheel back with the mouse wheel: a tick at each detent.
		const before = (await browser.evaluate<string[]>("window.__haptics")).length;
		// Where the wheel is once the transcript has settled: its middle, with nothing over it.
		const middle =
			"(r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))(document.querySelector('.activity-ticker').getBoundingClientRect())";
		await browser.wait(
			`(c => document.elementFromPoint(c.x, c.y)?.closest('.activity-ticker'))(${middle}) && !document.querySelector('.messages').getAnimations().length`,
		);
		const center = await browser.evaluate<{ x: number; y: number }>(middle);
		for (let step = 0; step < 3; step++) {
			await browser.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...center, deltaX: 0, deltaY: -48 });
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		await browser.wait(`window.__haptics.slice(${before}).filter((call) => call === "selectionChanged").length >= 2`);
	});
});
