// The Settings window in the browser: the gear beside the theme switch opens it; its own sections save settings.json,
// and the plugins' sheets (Providers, ...) show as its pages, on wide screens beside the list, on phones after it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, poll, startFixture } from "./helpers.ts";

const setValue = (selector: string, value: string, event: "input" | "change") =>
	`(() => { const element=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true})); })()`;
const navItem = (label: string) =>
	`[...document.querySelectorAll('.settings-nav-item')].find((e) => e.textContent === ${JSON.stringify(label)})`;
const screenshot = async (browser: Browser, name: string) => {
	if (!process.env.P2_SCREENSHOTS) return;
	const shot = (await browser.call("Page.captureScreenshot")) as { data: string };
	writeFileSync(join(process.env.P2_SCREENSHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
};

describe("Settings window", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("opens from the sidebar's gear at General and saves a choice, a text field and a switch", async () => {
		const file = join(fixture.dataDir, "settings.json");
		const read = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		writeFileSync(file, JSON.stringify({ thinkingLevel: "low" }));
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`document.querySelector('.drawer-foot .settings-open + .theme-toggle')`);
		await browser.click(".drawer-foot .settings-open");
		await browser.wait(
			`document.querySelector('[role=dialog][aria-label=Settings] .settings-page[aria-label=General] select')`,
		);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('[role=dialog] [aria-current=page]').textContent`),
			"General",
		);
		const detail = `.settings-page select`;
		await browser.evaluate(setValue(detail, "4", "change"));
		await poll(() => read().detail === 4);
		assert.deepEqual(read(), { thinkingLevel: "low", detail: 4 });

		const name = `.settings-page input[placeholder=Owner]`;
		await browser.evaluate(`document.querySelector(${JSON.stringify(name)}).focus()`);
		await browser.evaluate(setValue(name, "Mario", "input"));
		assert.equal(read().ownerName, undefined, "a text field saves when it loses focus");
		await browser.evaluate(`document.querySelector(${JSON.stringify(name)}).blur()`);
		await poll(() => read().ownerName === "Mario");

		// Back to the default: the setting leaves the file.
		await browser.evaluate(setValue(detail, "", "change"));
		await poll(() => read().detail === undefined);
		assert.deepEqual(read(), { thinkingLevel: "low", ownerName: "Mario" });

		await browser.evaluate(`${navItem("Agent")}.click()`);
		await browser.wait(`document.querySelector('.settings-page[aria-label=Agent] [role=switch]')`);
		await screenshot(browser, "desktop-agent");
		await browser.click(".settings-page [role=switch]");
		await poll(() => read().codemode === false);
		await browser.click(".settings-page [role=switch]");
		await poll(() => read().codemode === undefined);

		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('[role=dialog]')`);
	});

	it("shows a plugin's sheet as a page beside the list", async () => {
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.click(".drawer-foot .settings-open");
		await browser.wait(navItem("Providers"));
		await browser.evaluate(`${navItem("Providers")}.click()`);
		await browser.wait(
			`document.querySelector('[role=dialog][aria-label=Settings] .settings-page[aria-label=Providers]')`,
		);
		await screenshot(browser, "desktop-providers");
		assert.equal(await browser.evaluate<number>(`document.querySelectorAll('[role=dialog]').length`), 1);
		// The plugins' sections (SettingsSections) follow the window's own, by their order; Voice needs a speech service.
		assert.deepEqual(
			await browser.evaluate<string[]>(
				`[...document.querySelectorAll('.settings-nav-item')].map((e) => e.textContent)`,
			),
			[
				"General",
				"Models",
				"Agent",
				"Requests",
				"Compaction",
				"Providers",
				"MCP servers",
				"Environments",
				"Ports",
				"Devices",
				"Discord",
				"Logs",
				"Traces",
			],
		);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('[role=dialog] [aria-current=page]').textContent`),
			"Providers",
		);
		await browser.evaluate(`${navItem("Environments")}.click()`);
		await browser.wait(`document.querySelector('.settings-page[aria-label=Environments]')`);
		// Choosing a section beside the list is no new step: Back closes the window.
		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('[role=dialog]')`);
	});

	it("on phones shows the list, then a section with Back to the list", async () => {
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`document.querySelector('.drawer-foot .settings-open')`);
		await browser.evaluate(`document.querySelector('.drawer-foot .settings-open').click()`);
		await browser.wait(`${navItem("Providers")}?.offsetParent && !document.querySelector('.settings-page')`);
		await screenshot(browser, "phone-list");
		await browser.evaluate(`${navItem("Models")}.click()`);
		await browser.wait(
			`document.querySelector('.settings-page[aria-label=Models] select') && !${navItem("Providers")}.offsetParent`,
		);
		await screenshot(browser, "phone-models");
		await browser.click(".settings-page button[aria-label=Back]");
		await browser.wait(`${navItem("Providers")}?.offsetParent && !document.querySelector('.settings-page')`);
		await browser.evaluate(`${navItem("Providers")}.click()`);
		await browser.wait(`document.querySelector('.settings-page[aria-label=Providers] input')`);
		await screenshot(browser, "phone-providers");
		await browser.evaluate("history.back()");
		await browser.wait(`${navItem("Providers")}?.offsetParent && !document.querySelector('.settings-page')`);
	});
});
