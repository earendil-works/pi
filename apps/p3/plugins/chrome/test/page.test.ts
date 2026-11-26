// The page in a real browser (only when asked: `P3_BROWSER_TESTS=1` with `CHROMIUM_BIN`), on p3's real server with a
// copy of the built-in plugins the test edits and the tests' kinds (a note without a view, a wall that takes the page):
// `/` goes to the person's topmost workspace; the navigator shows the person, the workspaces and the open one's four
// groups; a plain workspace opens in its Settings view (on a phone its navigator first), whose who-may writes one grant
// row per checkbox (given, reset, withheld) and folds the Make ticks into one column; the add-thing picker groups by
// plugin and previews a kind's default grants, which the person may untick; a thing with a view opens in it, one
// without in its Settings view; a thing from above is greyed and a hidden one folded; a view that takes the whole page
// keeps only the corner button; the invite dialog says what comes with slice 3; `/me` is the person's own page; a
// session made through the picker opens from the navigator in its transcript view, streams a scripted answer, and shows
// a person with Read only the transcript with no way to send; a reload of the chrome plugin keeps the open page; an
// apply whose web contracts are newer than the page's base leaves it working, and a component the base lacks is
// reported once. Screenshots at the phone's and the desktop's size, light and dark, go to `/tmp/p3-base/shots/`
// (`P3_SHOTS` names another directory).

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type Host, Me, type P3Principal, People, until } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { scriptFaux } from "../../../test/support.ts";
import { eventually, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import { BROWSER_SKIP, Browser, DESKTOP, PHONE } from "./browser.ts";

/** The checkout's built-in plugins, which the test copies and edits. */
const BUILT_IN = fileURLToPath(new URL("../../", import.meta.url));

/** The tests' faux login: a model login answering from a script (`scriptFaux`). */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/** The tests' kinds: a note without a view, a wall whose view takes the whole page. */
const KINDS = fileURLToPath(new URL("../../../test/plugins/page-kinds/", import.meta.url));

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
	/** The owner's client. */
	let owner: Host<P3Principal>;
	/** The session the session cases share (its id: its workspace's), made through the picker. */
	let session: string;

	before(async () => {
		await mkdir(SHOTS, { recursive: true });
		const dataDir = await mkdtemp(join(tmpdir(), "p3-page-"));
		builtIn = join(dataDir, "builtin");
		await cp(BUILT_IN, builtIn, { recursive: true, filter: (path) => basename(path) !== "test" });
		t = await testServer({ dataDir, builtIn, plugins: [KINDS, FAUX] }, context);
		owner = await t.client(context);
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

	/** Asserts the page idles: the main thread busy under 0.2 s of one second with no input (no render loop). */
	async function idles(): Promise<void> {
		await browser.call("Performance.enable");
		const busy = async () =>
			(
				(await browser.call("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
			).metrics.find((metric) => metric.name === "TaskDuration")!.value;
		const first = await busy();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const spent = (await busy()) - first;
		assert.ok(spent < 0.2, `the idle page was busy ${spent} s of 1 s`);
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
		// The navigator's path settles: an idle page does no work (review round 1: a render loop kept it busy).
		await idles();
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
		await press('[data-add-offer="make:page-kinds.note"]');
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
		const plansEntry = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-nav-group="here"] [data-nav-thing]')].find((e) => e.textContent === "Plans").dataset.navThing`,
		);
		await press(`[data-nav-thing="${plansEntry}"]`);
		await browser.wait(`document.querySelector('[data-settings] [data-settings-title]')?.textContent === "Plans"`);
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "given",
		);
		assert.equal(await look("agents", "write"), "empty");
		// The kind's plugin wrote everyone's Read at the link: the cell says so (93, test 7a).
		assert.equal(
			await browser.evaluate(
				`document.querySelector('[data-who-may-row="everyone"] [data-tick="read"] [data-source]')?.dataset.source`,
			),
			"kind-default",
		);
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
		// Pi's things come down: the Sketch and Plans among them (beside what plugins seed in Pi, the session defaults).
		await browser.wait(
			`["Sketch", "Plans"].every((name) => [...document.querySelectorAll('[data-nav-group="above"] [data-nav-thing]')].some((e) => e.textContent.startsWith(name)))`,
		);
		await browser.wait(`document.querySelector('[data-nav-group="above"]')?.textContent.includes("from Pi")`);
		await press('[data-settings-tab="what"]');
		// Plans is hidden here by name: the rows' order is no promise.
		await browser.wait(
			`[...document.querySelectorAll("[data-here-thing]")].some((e) => e.textContent.includes("Plans"))`,
		);
		const plans = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-here-thing]')].find((e) => e.textContent.includes("Plans")).dataset.hereThing`,
		);
		await press(`[data-here-thing="${plans}"] [data-switch]`);
		await browser.wait(`document.querySelector("[data-nav-hidden]")?.textContent === "1 hidden"`);
		await shots("07-family-desktop");
		// Below the root too, the path settles.
		await idles();
		// Below the link (a thing hidden here gives nothing here, so the Sketch): everyone's Draw is inherited; unticking it
		// withholds it here, ticking it again resets the cell; an empty box (everyone's Moderate) is disabled.
		const sketch = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-here-thing]')].find((e) => e.textContent.includes("Sketch")).dataset.hereThing`,
		);
		const family = decodeURIComponent((await browser.evaluate<string>("location.pathname")).split("/")[2]!);
		await browser.open(`${origin}/w/${family}/t/${sketch}/settings`);
		await eventually(
			() => look("everyone", "draw"),
			(found) => found === "inherited",
		);
		const box = `document.querySelector('[data-who-may-row="everyone"] [data-tick="moderate"] [role="checkbox"]')`;
		assert.equal(
			await browser.evaluate(
				`${box}?.getAttribute("aria-disabled") === "true" || ${box}?.hasAttribute("data-disabled")`,
			),
			true,
		);
		await press('[data-who-may-row="everyone"] [data-tick="draw"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "draw"),
			(found) => found === "withheld",
		);
		await shots("08-withheld-desktop");
		await press('[data-who-may-row="everyone"] [data-tick="draw"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "draw"),
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
		await add("make:page-kinds.wall", "Wall");
		await browser.wait(`[...document.querySelectorAll('[data-nav-thing]')].some((e) => e.textContent === "Wall")`);
		const wall = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === "Wall").dataset.navThing`,
		);
		await press(`[data-nav-thing="${wall}"]`);
		await browser.wait(`document.querySelector("[data-wall]") && document.querySelector('[data-area="page"]')`);
		assert.equal(await browser.evaluate(`document.querySelector("[data-navigator]")`), null);
		// The chrome learns the view's area from the view itself: giving it the page must not mount it a second time.
		assert.equal(await browser.evaluate("window.wallMounts"), 1);
		// The wall lays a fixed overlay over everything it can reach; the corner button stays on top (decision 64).
		const onTop = await browser.evaluate<boolean>(
			`(() => { const e = document.querySelector("[data-corner-menu]"); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit !== null && (e === hit || e.contains(hit)); })()`,
		);
		assert.equal(onTop, true, "the whole-page view covers the corner button");
		await press("[data-corner-menu]");
		await press("[data-corner-navigator]");
		await browser.settled("[data-corner-drawer]");
		await shots("11-page-view-drawer-desktop");
		await press(`[data-corner-drawer] [data-nav-workspace="${pi}"]`);
		await browser.wait(`document.querySelector('[data-area="main"] [data-settings="${pi}"]')`);
	});

	it("mounts a view anew for another thing of its kind", async () => {
		await add("make:page-kinds.wall", "Wall 2");
		const walls = `[...document.querySelectorAll('[data-nav-thing]')].filter((e) => e.textContent.startsWith("Wall"))`;
		await browser.wait(`${walls}.length === 2`);
		const [first, second] = await browser.evaluate<string[]>(`${walls}.map((e) => e.dataset.navThing)`);
		await press(`[data-nav-thing="${first}"]`);
		await browser.wait(`document.querySelector('[data-wall="${first}"]')`);
		const mounted = await browser.evaluate<number>("window.wallMounts");
		await press("[data-corner-menu]");
		await press("[data-corner-navigator]");
		await browser.settled("[data-corner-drawer]");
		await press(`[data-corner-drawer] [data-nav-thing="${second}"]`);
		await browser.wait(`document.querySelector('[data-wall="${second}"]')`);
		// A view's own state (a draft, a selection, what it has seen) is one thing's: it never moves on to the next.
		assert.equal(await browser.evaluate("window.wallMounts"), mounted + 1);
		await press("[data-corner-menu]");
		await press("[data-corner-navigator]");
		await browser.settled("[data-corner-drawer]");
		await press(`[data-corner-drawer] [data-nav-workspace="${pi}"]`);
		await browser.wait(`document.querySelector('[data-area="main"] [data-settings="${pi}"]')`);
	});

	it("opens the invite dialog, which says what comes with slice 3", async () => {
		await press("[data-invite-open]");
		await browser.settled("[data-invite-dialog]");
		await press('[data-invite-as="guest"]');
		await press("[data-invite-create]");
		// Invite links are slice 3's (ERNDL-1144): until then the server says so, and the dialog shows it.
		await browser.wait(`document.querySelector("[data-invite-failure]")?.textContent.includes("This comes later.")`);
		await shots("12-invite-desktop");
		await browser.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
		await browser.wait(`document.querySelector("[data-invite-dialog]") === null`);
	});

	it("shows the person's own page at /me", async () => {
		await press("[data-nav-me]");
		await browser.wait(`location.pathname === "/me" && document.querySelector("[data-me]")`);
		await shots("13-me-desktop");
	});

	it("makes a session through the picker and opens it from the navigator in its transcript view", async () => {
		await browser.size(DESKTOP);
		await browser.open(`${origin}/w/${pi}/settings`);
		await browser.wait(`document.querySelector('[data-settings="${pi}"]')`);
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await browser.settled("[data-add-thing-dialog]");
		await press('[data-add-offer="make:sessions.session"]');
		await browser.wait(`document.querySelector("[data-new-session]")`);
		await browser.type("[data-add-name]", "First steps");
		await shots("14-new-session-desktop");
		await press("[data-add-confirm-button]");
		await browser.wait(`document.querySelector("[data-add-thing-dialog]") === null`);
		const entry = `[...document.querySelectorAll('[data-nav-group="sessions"] [data-nav-workspace]')].find((e) => e.textContent === "First steps")`;
		await browser.wait(`${entry} !== undefined`);
		session = await browser.evaluate<string>(`${entry}.dataset.navWorkspace`);
		await press(`[data-nav-workspace="${session}"]`);
		await browser.wait(`document.querySelector('[data-session-view="${session}"] [data-transcript="writer"]')`);
		await browser.wait(`document.querySelector("[data-crumbs]")?.textContent.includes("First steps")`);
		await shots("15-session-desktop");
	});

	it("streams a scripted answer into the session's transcript", async () => {
		const reply = { kind: "text" as const, text: "Hello from the faux model." };
		await scriptFaux(t.host, session, [{ when: "hello", reply: [reply] }], context);
		await browser.type("[data-message]", "hello there");
		await browser.enter();
		await browser.wait(`document.querySelector('[data-entry="user"]')?.textContent === "hello there"`);
		await browser.wait(
			`[...document.querySelectorAll('[data-entry="assistant"]')].some((e) => e.textContent.includes("Hello from the faux model."))`,
		);
		await shots("16-answer-desktop");
		await browser.size(PHONE);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')?.offsetParent !== null`);
		await shots("17-answer-phone");
		await browser.size(DESKTOP);
	});

	it("shows a person with Read only the session's transcript, with no way to send", async () => {
		// Ada is invited, put into Pi, and her Send on the session withheld: she keeps everyone's Read.
		const { person: ada, link } = await (await owner.get(People, {}, context)).invite({ name: "Ada" }, context);
		await t.host.root(async (ctx) => {
			const store = await ctx.get(ThingsStore, {});
			const party = { kind: "person", person: ada } as const;
			const source = { kind: "person", person: ownerId } as const;
			await store.putParty({ workspace: pi, party, source }, ctx);
			await store.setGrants(
				{ source, grants: [{ workspace: session, thing: session, party, tick: "send", gives: false }] },
				ctx,
			);
		}, context);
		await browser.signOut();
		await browser.open(`${origin}${link}`);
		await browser.wait(`document.querySelector("[data-person-menu]")?.textContent.includes("Ada")`);
		await browser.open(`${origin}/w/${session}`);
		await browser.wait(`document.querySelector('[data-session-view="${session}"] [data-transcript="reader"]')`);
		await browser.wait(
			`[...document.querySelectorAll('[data-entry="assistant"]')].some((e) => e.textContent.includes("Hello from the faux model."))`,
		);
		assert.equal(await browser.evaluate(`document.querySelector("[data-composer]")`), null);
		await shots("18-reader-desktop");
		await browser.signOut();
		await browser.signIn(origin, await t.cookie(context));
	});

	it("on a phone, reaches a plain workspace's Settings from the navigator, and goes back from a session and /me", async () => {
		await browser.size(PHONE);
		await browser.open(`${origin}/w/${pi}`);
		await browser.wait(`document.querySelector("[data-navigator]")?.offsetParent !== null`);
		const length = await browser.evaluate<number>("history.length");
		// Tapping the open workspace brings its Settings view forward, at the same address.
		await press(`[data-nav-workspace="${pi}"]`);
		await browser.wait(`document.querySelector('[data-settings="${pi}"]')?.offsetParent !== null`);
		assert.equal(await browser.evaluate("history.length"), length, "a duplicate address was pushed");
		await shots("19-pi-settings-phone");
		await press("[data-back]");
		await browser.wait(`document.querySelector("[data-navigator]")?.offsetParent !== null`);
		// A session (a workspace with its own view): Back shows its navigator.
		await browser.open(`${origin}/w/${session}`);
		await browser.wait(`document.querySelector('[data-session-view="${session}"]')?.offsetParent !== null`);
		await press("[data-back]");
		await browser.wait(`document.querySelector("[data-navigator]")?.offsetParent !== null`);
		assert.equal(await browser.evaluate("location.pathname"), `/w/${session}`);
		await press(`[data-nav-workspace="${session}"]`);
		await browser.wait(`document.querySelector('[data-session-view="${session}"]')?.offsetParent !== null`);
		// `/me` has a way back too.
		await browser.open(`${origin}/me`);
		await browser.wait(`document.querySelector("[data-me]")?.offsetParent !== null`);
		await press("[data-back]");
		await browser.wait(`location.pathname.startsWith("/w/")`);
		await browser.size(DESKTOP);
	});

	it("opens a workspace made without a name, named by its kind", async () => {
		await browser.open(`${origin}/w/${pi}/settings`);
		await browser.wait(`document.querySelector('[data-settings="${pi}"]')`);
		await add("make:things.workspace", "");
		const entry = `[...document.querySelectorAll('[data-nav-group="sessions"] [data-nav-workspace]')].find((e) => e.textContent === "Workspace")`;
		await browser.wait(`${entry} !== undefined`);
		const id = await browser.evaluate<string>(`${entry}.dataset.navWorkspace`);
		await browser.open(`${origin}/w/${id}`);
		await browser.wait(
			`document.querySelector('[data-settings="${id}"] [data-settings-title]')?.textContent === "Workspace"`,
		);
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
				'	self.contribute(Views, [{ view: "skew.person", title: { namespace: "skew", key: "person", params: [] }, area: "main", for: { kind: "person" }, View: Person }]),',
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

	it("leaves nothing reported on the server, and no error in the page but the component the base lacks", async () => {
		assert.deepEqual(t.errors, []);
		// A web facet that does not build is left out of the page without a word at the start; only an apply's report
		// names it. Every plugin's page part must be there.
		const { steps } = await t.apply(context);
		const failed = steps.flatMap(({ hosts }) =>
			hosts.flatMap((host) => (host.kind === "reloaded" ? host.report.failed : [])),
		);
		assert.deepEqual(failed, []);
		assert.deepEqual(
			browser.console.filter((line) => !line.includes(MISSING_COMPONENT)),
			[],
		);
	});
});
