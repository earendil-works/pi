// Browser: a theme change after load cross-fades in a view transition of type `pi-theme` (src/web/theme.ts); the first
// paint does not. A script installed before the page's own records each `startViewTransition` call.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, poll, startFixture } from "./helpers.ts";

/** Records the page's view transitions in `window.fades`: their types, and whether the type selector matched. */
const RECORDER = `window.fades = [];
const start = Document.prototype.startViewTransition;
Document.prototype.startViewTransition = function (argument) {
	const transition = start.call(this, argument);
	const fade = { types: typeof argument === "function" ? null : argument.types, matched: false };
	window.fades.push(fade);
	transition.ready.then(() => { fade.matched = document.documentElement.matches(":active-view-transition-type(pi-theme)"); }, () => {});
	return transition;
};`;

describe("theme fade", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(1280, 800);
		await browser.call("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-color-scheme", value: "light" }],
		});
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("fades a pick after load, not the first paint", async () => {
		const base = `http://127.0.0.1:${fixture.server.port}`;
		await browser.open(`${base}/`);
		await browser.evaluate(`localStorage.setItem("pi-theme", "dark")`);
		await browser.open(`${base}/`);
		await browser.wait(`document.querySelector(".theme-toggle")`);
		assert.deepEqual(await browser.evaluate("fades"), []);
		assert.equal(await browser.evaluate("document.documentElement.dataset.theme"), "dark");

		// Slowed down, so the fade still runs when it is checked.
		await browser.call("Animation.enable");
		await browser.call("Animation.setPlaybackRate", { playbackRate: 0.1 });
		await browser.evaluate(`document.querySelector(".theme-toggle").click()`);
		await browser.wait(`fades[0]?.matched && document.activeViewTransition`);
		assert.deepEqual(await browser.evaluate("fades"), [{ types: ["pi-theme"], matched: true }]);
		await browser.call("Animation.setPlaybackRate", { playbackRate: 1 });
		await poll(
			async () => (await browser.evaluate("document.activeViewTransition")) === null,
			10_000,
			"the fade's end",
		);
		// Dark → System: the system's light.
		assert.equal(await browser.evaluate("document.documentElement.dataset.theme"), "light");
	});
});
