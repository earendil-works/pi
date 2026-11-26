// The page in a real browser (only when asked: `P3_BROWSER_TESTS=1` with `CHROMIUM_BIN`), on p3's real server with a
// copy of the built-in plugins the test edits, and the workspaces stub standing in for slice 2's server side: `/`
// goes to the person's topmost workspace; the navigator shows the person, the workspaces and the open one's four
// groups; a plain workspace opens in its Settings view (on a phone its navigator first), whose who-may writes one grant
// row per checkbox (given, reset, withheld) and folds the Make ticks into one column; the add-thing picker groups by
// plugin and previews a kind's default grants, which the person may untick; a thing with a view opens in it, one
// without in its Settings view; a thing from above is greyed and a hidden one folded; a view that takes the whole
// page keeps only the corner button; the invite dialog makes a link; `/me` is the person's own page; a reload of the
// chrome plugin keeps the open page; an apply whose web contracts are newer than the page's base leaves it working,
// and a component the base lacks is reported once. Screenshots at the phone's and the desktop's size, light and dark,
// go to `/tmp/p3-base/shots/` (`P3_SHOTS` names another directory).

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, Me, until } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { eventually, within } from "../../../test/until.ts";
import { BROWSER_SKIP, Browser, DESKTOP, PHONE } from "./browser.ts";

/** The checkout's built-in plugins, which the test copies and edits. */
const BUILT_IN = fileURLToPath(new URL("../../", import.meta.url));

/** The stand-in for slice 2's server side: workspaces, their lists, who may. */
const STUB = fileURLToPath(new URL("../../../test/plugins/workspaces-stub/", import.meta.url));

/** Where the screenshots go. */
const SHOTS = process.env.P3_SHOTS ?? "/tmp/p3-base/shots";

/** What `useComponent` reports for a component token the page's base does not have. */
const MISSING_COMPONENT = "a component this page's base does not have";

describe("the page", { skip: BROWSER_SKIP }, () => {
	let t: TestServer;
	let builtIn: string;
	let browser: Browser;
	let origin: string;
	/** Pi, the root workspace (its id), once the landing went there. */
	let pi: string;
	/** The owner's person id. */
	let ownerId: string;

	before(async () => {
		await mkdir(SHOTS, { recursive: true });
		const dataDir = await mkdtemp(join(tmpdir(), "p3-page-"));
		builtIn = join(dataDir, "builtin");
		await cp(BUILT_IN, builtIn, { recursive: true, filter: (path) => basename(path) !== "test" });
		t = await testServer({ dataDir, builtIn, plugins: [STUB] }, context);
		const owner = await t.client(context);
		const me = await until((await owner.get(Me, {}, context)).me, () => true, context);
		if (me.kind !== "person") assert.fail(me.kind);
		ownerId = me.id;
		origin = `http://127.0.0.1:${t.port}`;
		browser = await Browser.start();
		await browser.signIn(origin, await t.cookie(context));
	});

	after(async () => {
		await browser?.close();
		await t?.close(context);
	});

	/** Clicks the first element `selector` matches once it exists, scrolled into the middle of its scroller first. */
	async function press(selector: string): Promise<void> {
		const at = JSON.stringify(selector);
		await browser.wait(`document.querySelector(${at}) !== null`);
		await browser.evaluate(`document.querySelector(${at}).scrollIntoView({ block: "center" })`);
		await browser.click(selector);
	}

	/** Screenshots `name` in light and dark. */
	async function shots(name: string): Promise<void> {
		await browser.screenshot(join(SHOTS, `${name}.png`));
		await browser.colorScheme("dark");
		await browser.screenshot(join(SHOTS, `${name}-dark.png`));
		await browser.colorScheme("light");
	}

	/** The look of `party`'s checkbox for `tick` in the who-may table on a wide screen. */
	function look(party: string, tick: string): Promise<string | undefined> {
		return browser.evaluate<string | undefined>(
			`document.querySelector('[data-who-may-row="${party}"] [data-tick="${tick}"]')?.dataset.look`,
		);
	}

	/** Makes a thing of `offer` (`make:<kind>`) named `name` through the add-thing picker of the open Settings view. */
	async function add(offer: string, name: string, untick: readonly string[] = []): Promise<void> {
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await browser.settled("[data-add-thing-dialog]");
		await press(`[data-add-offer="${offer}"]`);
		await browser.type("[data-add-name]", name);
		for (const tick of untick) await press(`[data-add-default="${tick}"]`);
		await press("[data-add-confirm-button]");
		await browser.wait(`document.querySelector("[data-add-thing-dialog]") === null`);
	}

	it("goes from / to the person's topmost workspace, with the navigator beside its Settings view", async () => {
		await browser.size(DESKTOP);
		await browser.open(`${origin}/`);
		await browser.wait(`location.pathname.startsWith("/w/")`);
		pi = decodeURIComponent((await browser.evaluate<string>("location.pathname")).split("/")[2]!);
		await browser.wait(`document.querySelector('[data-nav-workspace="${pi}"]')?.textContent === "Pi"`);
		await browser.wait(`document.querySelector("[data-nav-me]")?.textContent.length > 0`);
		await browser.wait(
			`document.querySelector('[data-settings="${pi}"] [data-settings-title]')?.textContent === "Pi"`,
		);
		await browser.wait(`document.querySelector('[data-connection="connected"]')`);
		// Going back leaves the page: `/` was replaced, not pushed.
		assert.equal(await browser.evaluate("history.length"), 2);
		await shots("01-pi-settings-desktop");
	});

	it("folds a workspace's Make ticks into one column", async () => {
		await press('[data-settings-tab="may"]');
		await browser.wait(`document.querySelector('[data-who-may-row="everyone"]')`);
		assert.equal(await look("everyone", "link"), "empty");
		await press('[data-make="everyone"]');
		await browser.settled("[data-make-popup]");
		await browser.wait(`document.querySelector('[data-make-popup] [data-tick="@make:canvas.board"]')`);
		await shots("02-make-popup-desktop");
		await browser.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
		await browser.wait(`document.querySelector("[data-make-popup]") === null`);
	});

	it("previews a kind's default grants in the picker; what is unticked is not written, a view-less thing opens its Settings view", async () => {
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await browser.settled("[data-add-thing-dialog]");
		await shots("03-picker-desktop");
		await press('[data-add-offer="make:workspaces-stub.note"]');
		await browser.wait(
			`document.querySelector('[data-add-defaults="everyone"]')?.textContent.includes("Everyone here may Read")`,
		);
		await browser.wait(
			`document.querySelector('[data-add-defaults="agents"]')?.textContent.includes("Agents here may Write")`,
		);
		await browser.type("[data-add-name]", "Plans");
		await press('[data-add-default="agents/write"]');
		await shots("04-picker-defaults-desktop");
		await press("[data-add-confirm-button]");
		await browser.wait(`document.querySelector("[data-add-thing-dialog]") === null`);
		await browser.wait(
			`[...document.querySelectorAll('[data-nav-group="here"] [data-nav-thing]')].some((e) => e.textContent === "Plans")`,
		);
		await press('[data-nav-group="here"] [data-nav-thing]');
		await browser.wait(`document.querySelector('[data-settings] [data-settings-title]')?.textContent === "Plans"`);
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "given",
		);
		assert.equal(await look("agents", "write"), "empty");
		await shots("05-thing-settings-desktop");
		// One checkbox is one row: unticking a given tick deletes it, ticking writes it again.
		await press('[data-who-may-row="everyone"] [data-tick="read"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "empty",
		);
		await press('[data-who-may-row="everyone"] [data-tick="read"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "given",
		);
	});

	it("opens a thing with a view in it: a canvas made through the picker", async () => {
		await press(`[data-nav-workspace="${pi}"]`);
		await browser.wait(`document.querySelector('[data-settings="${pi}"]')`);
		await add("make:canvas.board", "Sketch");
		await browser.wait(`[...document.querySelectorAll('[data-nav-thing]')].some((e) => e.textContent === "Sketch")`);
		const sketch = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === "Sketch").dataset.navThing`,
		);
		await press(`[data-nav-thing="${sketch}"]`);
		await browser.wait(`document.querySelector('section[aria-label="Canvas"]')`);
		await browser.wait(`document.querySelector("[data-gear]")`);
		await shots("06-canvas-desktop");
		await press("[data-gear]");
		await browser.wait(`location.pathname.endsWith("/settings")`);
		await browser.wait(`document.querySelector('[data-settings="${sketch}"]')`);
	});

	it("shows things from above greyed in a workspace below, and folds a hidden one", async () => {
		await press(`[data-nav-workspace="${pi}"]`);
		await add("make:things.workspace", "Family");
		await browser.wait(
			`[...document.querySelectorAll('[data-nav-group="sessions"] [data-nav-workspace]')].some((e) => e.textContent === "Family")`,
		);
		await press('[data-nav-group="sessions"] [data-nav-workspace]');
		await browser.wait(`document.querySelector('[data-settings-title]')?.textContent === "Family"`);
		await browser.wait(`document.querySelectorAll('[data-nav-group="above"] [data-nav-thing]').length === 2`);
		await browser.wait(`document.querySelector('[data-nav-group="above"]')?.textContent.includes("from Pi")`);
		await press('[data-settings-tab="what"]');
		await press("[data-what-is-here] [data-switch]");
		await browser.wait(`document.querySelector("[data-nav-hidden]")?.textContent === "1 hidden"`);
		await shots("07-family-desktop");
		// Below the link: everyone's Read on Plans is inherited; unticking it withholds it here; an empty box is disabled.
		const plans = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-here-thing]')].find((e) => e.textContent.includes("Plans")).dataset.hereThing`,
		);
		const family = decodeURIComponent((await browser.evaluate<string>("location.pathname")).split("/")[2]!);
		await browser.open(`${origin}/w/${family}/t/${plans}/settings`);
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "inherited",
		);
		const box = `document.querySelector('[data-who-may-row="agents"] [data-tick="write"] [role="checkbox"]')`;
		assert.equal(
			await browser.evaluate(
				`${box}?.getAttribute("aria-disabled") === "true" || ${box}?.hasAttribute("data-disabled")`,
			),
			true,
		);
		await press('[data-who-may-row="everyone"] [data-tick="read"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "withheld",
		);
		await shots("08-withheld-desktop");
		await press('[data-who-may-row="everyone"] [data-tick="read"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "inherited",
		);
		await browser.open(`${origin}/w/${family}`);
		await browser.wait(`document.querySelector("[data-nav-hidden]")`);
		await browser.size(PHONE);
		await browser.wait(`document.querySelector("[data-navigator]")?.offsetParent !== null`);
		await shots("09-family-navigator-phone");
		await press('[data-nav-group="above"] [data-nav-thing]');
		await browser.wait(`document.querySelector("[data-back]")?.offsetParent !== null`);
		await shots("10-thing-phone");
		await press("[data-back]");
		await browser.wait(`document.querySelector("[data-navigator]")?.offsetParent !== null`);
		await browser.size(DESKTOP);
	});

	it("gives a view that takes the whole page the page, with the corner button and its navigator", async () => {
		await press(`[data-nav-workspace="${pi}"]`);
		await add("make:workspaces-stub.wall", "Wall");
		await browser.wait(`[...document.querySelectorAll('[data-nav-thing]')].some((e) => e.textContent === "Wall")`);
		const wall = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === "Wall").dataset.navThing`,
		);
		await press(`[data-nav-thing="${wall}"]`);
		await browser.wait(`document.querySelector("[data-wall]") && document.querySelector('[data-area="page"]')`);
		assert.equal(await browser.evaluate(`document.querySelector("[data-navigator]")`), null);
		await press("[data-corner-menu]");
		await press("[data-corner-navigator]");
		await browser.settled("[data-corner-drawer]");
		await shots("11-page-view-drawer-desktop");
		await press(`[data-corner-drawer] [data-nav-workspace="${pi}"]`);
		await browser.wait(`document.querySelector('[data-area="main"] [data-settings="${pi}"]')`);
	});

	it("makes an invite link from the invite dialog", async () => {
		await press("[data-invite-open]");
		await browser.settled("[data-invite-dialog]");
		await press('[data-invite-as="guest"]');
		await press("[data-invite-create]");
		await browser.wait(`document.querySelector("[data-invite-url]")?.value.includes("/_p3/invite/")`);
		await shots("12-invite-desktop");
		await browser.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
		await browser.wait(`document.querySelector("[data-invite-dialog]") === null`);
	});

	it("shows the person's own page at /me", async () => {
		await press("[data-nav-me]");
		await browser.wait(`location.pathname === "/me" && document.querySelector("[data-me]")`);
		await shots("13-me-desktop");
	});

	it("keeps the open page through a reload of the chrome plugin", async () => {
		await browser.open(`${origin}/w/${pi}/settings`);
		await browser.wait(`document.querySelector('[data-settings="${pi}"]')`);
		await browser.evaluate("window.p3Marker = 1");
		const file = join(builtIn, "chrome", "messages.ts");
		await writeFile(file, (await readFile(file, "utf8")).replace('settings: "Settings",', 'settings: "Settings!",'));
		await until(t.plugins, (state) => state.dirty.length > 0, within("the edit seen", context, 10_000));
		await t.apply(context);
		await browser.wait(`document.querySelector("[data-crumbs]")?.textContent.includes("Settings!")`);
		assert.equal(await browser.evaluate("window.p3Marker"), 1, "the page loaded again");
	});

	it("renders a view that asks for a component the page's base lacks, reporting it once", async () => {
		// A plugin built against a newer API than the page's base: a component token the base does not have is
		// `undefined` here (`useComponent` of `undefined` stands for it). It is a person view, opened at /p/.
		await writeFile(
			join(t.userRoot, "skew.web.tsx"),
			[
				'import { defineFacet } from "@earendil-works/p3/v1";',
				'import { type ComponentToken, useComponent, Views } from "@earendil-works/p3/v1/web";',
				"function Person() {",
				"	const Missing = useComponent(undefined as unknown as ComponentToken<Record<string, never>>);",
				'	return <main><p data-skew="">Still here</p>{Missing === undefined ? <p data-skew-missing="">none</p> : <Missing />}</main>;',
				"}",
				"export default defineFacet((_host, self) =>",
				'	self.contribute(Views, { view: "skew.person", title: { namespace: "skew", key: "person", params: [] }, area: "main", for: { kind: "person" }, View: Person }),',
				");",
			].join("\n"),
		);
		await until(t.plugins, (state) => state.set, within("the new plugin seen", context, 10_000));
		await t.apply(context);
		const reported = () => browser.console.filter((line) => line.includes(MISSING_COMPONENT)).length;
		const before = reported();
		await browser.open(`${origin}/w/${pi}/p/${ownerId}`);
		await browser.wait(`document.querySelector("[data-skew]")?.textContent === "Still here"`);
		await browser.wait(`document.querySelector("[data-skew-missing]")`);
		assert.equal(await browser.evaluate(`document.querySelector("[data-view-error]") === null`), true);
		await eventually(reported, (count) => count === before + 1);
	});

	it("leaves nothing reported on the server, and no error in the page but the component the base lacks", () => {
		assert.deepEqual(t.errors, []);
		assert.deepEqual(
			browser.console.filter((line) => !line.includes(MISSING_COMPONENT)),
			[],
		);
	});
});
