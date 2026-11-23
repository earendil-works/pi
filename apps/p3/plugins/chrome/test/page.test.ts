// The page in a real browser (only when asked: `P3_BROWSER_TESTS=1` with `CHROMIUM_BIN`), on p3's real server with a
// copy of the built-in plugins the test edits and the tests' faux login: the bar shows the app and the connection; a
// session made through the form appears in the list and opens in the transcript, which streams a scripted answer; a
// phone shows one screen at a time; a reload of the chrome plugin keeps the open page, as does an apply whose web
// contracts are newer than the page's base; an app without the bar gets a corner button, an app that throws shows its
// error below the bar, and one asking for a view the base lacks renders, reported once; a person invited from the
// person menu and added to the session enters Coding and works in it, brings her own notebook and writes in it as a
// pane (the owner sees it as hers, sets its options in the page: everyone reads only, the agent writes; the agent's
// scripted note appears, her view turns read only) and withdraws it, sees the session refused once removed from it, and
// no app once removed from every session of Coding; things open as panes (a tab dragged to an edge splits, dividers
// resize, the layout survives a page load; on a phone chips and swipes); things named in the dialog show by name in
// their tabs and follow a rename; the sheet makes content and keeps it, My things lists the Pi's things, and a session
// stops following without losing what it had; a person's thing is made in My things through its kind's creation view,
// is in a following session "in all my sessions", and is given away and deleted. Screenshots of the steps at the
// phone's and the desktop's size go to `/tmp/p3-base/shots/` (`P3_SHOTS` names another directory).

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	type Host,
	Me,
	type P3Principal,
	SessionInfo,
	Sessions,
	SessionThings,
	Transcript,
	until,
} from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { FauxInboxStore } from "../../../test/plugins/faux-inbox/contract.ts";
import { FauxLogin, type Step } from "../../../test/plugins/faux-login/contract.ts";
import { eventually, within } from "../../../test/until.ts";
import { CanvasKind } from "../../canvas/contract.ts";
import { BROWSER_SKIP, Browser, DESKTOP, PHONE } from "./browser.ts";

/** The checkout's built-in plugins, which the test copies and edits. */
const BUILT_IN = fileURLToPath(new URL("../../", import.meta.url));

/** The tests' faux login: a kind of thing whose model answers from a script. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/** The tests' faux inbox: a kind a person makes in My things through its own creation view. */
const INBOX = fileURLToPath(new URL("../../../test/plugins/faux-inbox/", import.meta.url));

/** Where the screenshots go. */
const SHOTS = process.env.P3_SHOTS ?? "/tmp/p3-base/shots";

describe("the page", { skip: BROWSER_SKIP }, () => {
	let t: TestServer;
	let builtIn: string;
	let owner: Host<P3Principal>;
	let browser: Browser;
	let origin: string;
	/** The session the cases share, made through the form. */
	let session: string;
	/** The invited person's id. */
	let ada: string;
	/** The owner: their person's id and name. */
	let ownerId: string;
	let ownerName: string;
	/** The board the owner made and kept in the first session (its thing's id). */
	let boardId: string;
	/** The owner's notebook in the session (its thing's id), once they brought it. */
	let ownerNotes: string;
	/** The session's faux login (its thing's id) and its script so far. */
	let faux: string;
	let script: Step[];

	before(async () => {
		await mkdir(SHOTS, { recursive: true });
		const dataDir = await mkdtemp(join(tmpdir(), "p3-page-"));
		builtIn = join(dataDir, "builtin");
		await cp(BUILT_IN, builtIn, { recursive: true, filter: (path) => basename(path) !== "test" });
		t = await testServer({ dataDir, builtIn, plugins: [FAUX, INBOX] }, context);
		owner = await t.client(context);
		const me = await until((await owner.get(Me, {}, context)).me, () => true, context);
		if (me.kind !== "person") assert.fail(me.kind);
		ownerId = me.id;
		ownerName = me.name;
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

	/** Picks `value` (shown as `label`) in the dropdown whose trigger `trigger` matches. */
	async function pick(trigger: string, value: string, label: string): Promise<void> {
		await press(trigger);
		await browser.click(`[data-choice="${value}"]`);
		await browser.wait(
			`document.querySelector(${JSON.stringify(trigger)})?.textContent.includes(${JSON.stringify(label)})`,
		);
	}

	/** Opens the "⋯" menu of the first element `row` matches and, with `item`, picks that action. */
	async function menu(row: string, item?: string): Promise<void> {
		await press(`${row} [data-row-menu]`);
		await browser.wait(`document.querySelector("[data-row-popup]")`);
		if (item !== undefined) await browser.click(`[data-row-popup] [data-menu-item="${item}"]`);
		await browser.wait(item === undefined ? "true" : `document.querySelector("[data-row-popup]") === null`);
	}

	/** The actions in the "⋯" menu of `row` (none: `[]`, no menu), the menu closed again. */
	async function menuItems(row: string): Promise<string[]> {
		if (await browser.evaluate<boolean>(`document.querySelector('${row} [data-row-menu]') === null`)) return [];
		await menu(row);
		const items = await browser.evaluate<string[]>(
			`[...document.querySelectorAll("[data-row-popup] [data-menu-item]")].map((e) => e.dataset.menuItem)`,
		);
		await browser.click(`${row} [data-row-menu]`);
		await browser.wait(`document.querySelector("[data-row-popup]") === null`);
		return items;
	}

	/** Renames the thing of `row` to `name` through its menu, and waits for its row to show it. */
	async function rename(row: string, name: string): Promise<void> {
		await menu(row, "rename");
		const field = `${row} [data-field="rename"]`;
		await browser.wait(`document.querySelector('${field}')`);
		// Emptied as a person would (React sees the change), then typed.
		await browser.evaluate(
			`(() => { const input = document.querySelector('${field}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		await browser.type(field, name);
		await browser.wait(`document.querySelector('${field}')?.value === ${JSON.stringify(name)}`);
		await press(`${row} [data-rename-save]`);
		await browser.wait(`document.querySelector('${row} [data-thing-name]')?.textContent === ${JSON.stringify(name)}`);
	}

	/** The ids of the session sheet's things of `kind`. */
	function thingIds(kind: string): Promise<string[]> {
		return browser.evaluate(`[...document.querySelectorAll('[data-thing="${kind}"]')].map((e) => e.dataset.thingId)`);
	}

	/** Opens My things from the person menu, settled. */
	async function openMyThings(): Promise<void> {
		await browser.click("[data-person-menu]");
		await browser.click("[data-my-things-open]");
		await browser.settled("[data-my-things-dialog]");
	}

	/** Closes My things. */
	async function closeMyThings(): Promise<void> {
		await press('[data-my-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-my-things-dialog]") === null`);
	}

	/** The sign-in faux inbox `thing` was made with, as its kind keeps it on the server (`null`: none). */
	function signInOf(thing: string): Promise<string | null> {
		return t.host.root(async (ctx) => (await ctx.get(FauxInboxStore, {})).signInOf({ thing }, ctx), context);
	}

	/** Screenshots of the viewport as `<name>.png`, light, and `<name>-dark.png`. */
	async function shots(name: string): Promise<void> {
		await browser.screenshot(join(SHOTS, `${name}.png`));
		await browser.colorScheme("dark");
		await browser.screenshot(join(SHOTS, `${name}-dark.png`));
		await browser.colorScheme("light");
	}

	it("shows the bar with the app and the connection, and goes to the first app", async () => {
		await browser.size(DESKTOP);
		await browser.open(`${origin}/`);
		await browser.wait(`document.querySelector("[data-top-bar]")`);
		await browser.wait(`document.querySelector("[data-app-switcher]")?.textContent === "Coding"`);
		await browser.wait(`document.querySelector('[data-connection="connected"]')`);
		assert.equal(await browser.evaluate("location.pathname"), "/coding");
		await browser.wait(`document.querySelector("[data-new-session-open]")`);
		await browser.screenshot(join(SHOTS, "01-empty-desktop.png"));
	});

	it("makes a session through the form; it appears in the list and opens in the transcript", async () => {
		await browser.click("[data-new-session-open]");
		await browser.wait(`document.querySelector("[data-new-session]")`);
		await browser.type('[data-field="title"]', "First steps");
		await browser.type('[data-field="folder"]', t.dataDir);
		await browser.screenshot(join(SHOTS, "02-new-session-desktop.png"));
		await browser.click('[data-new-session] button[type="submit"]');
		await browser.wait(`document.querySelector("[data-session-title]")?.textContent === "First steps"`);
		session = await browser.evaluate<string>(`location.pathname.split("/")[2]`);
		await browser.wait(`document.querySelector('[data-session="${session}"]')?.textContent.includes("First steps")`);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')`);
		await browser.wait(`document.querySelector("[data-empty]")`);
		await browser.screenshot(join(SHOTS, "03-session-desktop.png"));
	});

	it("streams scripted answers, a tool call with its output among them, into the transcript", async () => {
		script = [
			{ when: "hello", reply: [{ kind: "text" as const, text: "Hello from the faux model." }] },
			{ when: "which title", reply: [{ kind: "tool" as const, name: "faux_session", args: "{}" }] },
			// The tool's result names the session's title.
			{ when: "First steps", reply: [{ kind: "text" as const, text: "It is called First steps." }] },
		];
		// The faux login is the Pi's, in all its sessions: the session has it from following its owner; its script is
		// this session's options for it.
		const info = await owner.get(SessionInfo, { session }, context);
		if (info.variant !== "info") return assert.fail(info.variant);
		const things = await until(
			info.things,
			(list) => list.some((thing) => thing.kind === FauxLogin.name),
			within("the faux login, followed", context, 10_000),
		);
		faux = things.find((thing) => thing.kind === FauxLogin.name)!.thing;
		await (await writerOf(owner, session)).setOptions(
			{ thing: faux, for: { kind: "everyone" }, options: { provider: "faux", script, tool: true } },
			context,
		);
		await browser.type("[data-message]", "hello there");
		await browser.enter();
		await browser.wait(`document.querySelector('[data-entry="user"]')?.textContent === "hello there"`);
		await browser.wait(
			`[...document.querySelectorAll('[data-entry="assistant"]')].some((e) => e.textContent.includes("Hello from the faux model."))`,
		);
		await browser.type("[data-message]", "which title is this?");
		await browser.click("[data-send]");
		await browser.wait(`document.querySelector('[data-tool="faux_session"][data-state="done"]')`);
		await browser.wait(
			`[...document.querySelectorAll('[data-entry="assistant"]')].some((e) => e.textContent.includes("It is called First steps."))`,
		);
		await browser.click('[data-tool="faux_session"] summary');
		await browser.wait(`document.querySelector('[data-tool="faux_session"]').open`);
		await browser.screenshot(join(SHOTS, "04-answer-desktop.png"));
	});

	it("opens what the session holds on demand", async () => {
		assert.equal(await browser.evaluate(`document.querySelector("[data-session-things]") === null`), true);
		await browser.click("[data-things-open]");
		await browser.wait(`document.querySelector('[data-thing="tools.coding"]')`);
		await browser.wait(`document.querySelector('[data-thing="faux.login"]')`);
		await browser.settled("[data-things-dialog]");
		await browser.screenshot(join(SHOTS, "05-things-desktop.png"));
		await browser.click('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-session-things]") === null`);
	});

	it("makes content in the sheet and keeps it, lists the Pi's things in My things, and stops following without loss", async () => {
		// The session follows the owner who made it: it has the Pi's coding tools from that, not removable here.
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(
			`document.querySelector('[data-following] [data-follows]')?.textContent === "Has your things"`,
		);
		const tools = '[data-thing="tools.coding"][data-by="followed"]';
		await browser.wait(`document.querySelector('${tools} [data-whose]')?.textContent === "From you"`);
		assert.deepEqual(await menuItems(tools), ["rename", "options"]);
		// "+": a canvas, this session's content, made at once and named after its kind; then renamed.
		const before = await thingIds("canvas.board");
		await press("[data-add-open]");
		await browser.click('[data-add-popup] [data-new-kind="canvas.board"]');
		await browser.wait(
			`[...document.querySelectorAll('[data-thing="canvas.board"]')].some((e) => !${JSON.stringify(before)}.includes(e.dataset.thingId))`,
		);
		boardId = (await thingIds("canvas.board")).find((id) => !before.includes(id))!;
		const row = `[data-thing-id="${boardId}"]`;
		await browser.wait(`document.querySelector('${row} [data-thing-name]')?.textContent === "Canvas"`);
		await browser.wait(`document.querySelector('${row} [data-whose]')?.textContent === "This session's"`);
		await rename(row, "Board");
		// "Keep": the owner gives it to themselves; it stays in the session.
		await menu(row, "keep");
		// Whatever the server calls the owner among whom they may give it (their name, "You"): picked by value.
		await press(`${row} [data-field="keeper"]`);
		await browser.click(`[data-choice="person:${ownerId}"]`);
		await press(`${row} [data-give-save]`);
		await browser.wait(`document.querySelector('${row} [data-whose]')?.textContent === "Yours"`);
		await browser.settled("[data-things-dialog]");
		await shots("26-sheet-desktop");
		await browser.size(PHONE);
		await browser.settled("[data-things-dialog]");
		await shots("26-sheet-phone");
		// Its options, behind its menu, and closed again from it.
		await menu(row, "options");
		await browser.wait(`document.querySelector('${row} [data-thing-options]')`);
		await shots("26-options-phone");
		await menu(row, "options");
		await browser.wait(`document.querySelector('${row} [data-thing-options]') === null`);
		await browser.size(DESKTOP);
		await press('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-things-dialog]") === null`);
		// My things, from the person menu: the Pi's coding tools (in all sessions) and the kept board (not).
		await openMyThings();
		const myTools = `[...document.querySelectorAll("[data-my-thing]")].find((e) => e.textContent.includes("Coding tools"))`;
		await browser.wait(`${myTools}?.textContent.includes("The Pi's")`);
		await browser.wait(`${myTools}?.querySelector("[data-everywhere]")?.getAttribute("aria-checked") === "true"`);
		await browser.wait(
			`document.querySelector('[data-my-thing="${boardId}"] [data-everywhere]')?.getAttribute("aria-checked") === "false"`,
		);
		await shots("27-my-things-desktop");
		await browser.size(PHONE);
		await browser.settled("[data-my-things-dialog]");
		await shots("27-my-things-phone");
		await browser.size(DESKTOP);
		await closeMyThings();
		// Stop following, keeping what it had: the coding tools stay, linked now.
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await press("[data-follow-open]");
		await pick('[data-following] [data-field="follows"]', "nobody", "Nobody");
		await press("[data-follow-save]");
		await browser.wait(
			`document.querySelector('[data-following="nobody"] [data-follows]')?.textContent === "Has nobody's things"`,
		);
		await browser.wait(`document.querySelector('[data-thing="tools.coding"]:not([data-by="followed"])')`);
		await browser.wait(`document.querySelector('[data-thing="faux.login"]:not([data-by="followed"])')`);
		await browser.settled("[data-things-dialog]");
		await shots("28-unfollowed-desktop");
		await press('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-things-dialog]") === null`);
	});

	it("shows one screen at a time on a phone", async () => {
		await browser.size(PHONE);
		await browser.open(`${origin}/coding`);
		await browser.wait(`document.querySelector('[data-session="${session}"]')`);
		await browser.screenshot(join(SHOTS, "06-list-phone.png"));
		await browser.click(`[data-session="${session}"]`);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')?.getBoundingClientRect().width > 0`);
		await browser.wait(`document.querySelector('[data-session="${session}"]')?.getBoundingClientRect().width === 0`);
		await browser.wait(
			`[...document.querySelectorAll('[data-entry="assistant"]')].some((e) => e.textContent.includes("faux model"))`,
		);
		await browser.screenshot(join(SHOTS, "07-session-phone.png"));
		await browser.colorScheme("dark");
		await browser.screenshot(join(SHOTS, "07-session-phone-dark.png"));
		await browser.colorScheme("light");
		await browser.click("[data-things-open]");
		await browser.wait(`document.querySelector('[data-thing="tools.coding"]')`);
		await browser.settled("[data-things-dialog]");
		await browser.screenshot(join(SHOTS, "07-things-phone.png"));
		await browser.colorScheme("dark");
		await browser.screenshot(join(SHOTS, "07-things-phone-dark.png"));
		await browser.colorScheme("light");
		await browser.click('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-session-things]") === null`);
		await browser.click('button[aria-label="Back to the sessions"]');
		await browser.wait(`location.pathname === "/coding"`);
		await browser.wait(`document.querySelector('[data-session="${session}"]')?.getBoundingClientRect().width > 0`);
		await browser.click("[data-new-session-open]");
		await browser.wait(`document.querySelector("[data-new-session]")?.getBoundingClientRect().width > 0`);
		await browser.screenshot(join(SHOTS, "07-new-session-phone.png"));
		await browser.click('button[aria-label="Back to the sessions"]');
		await browser.wait(`document.querySelector("[data-new-session]") === null`);
		await browser.size(DESKTOP);
	});

	it("keeps the open page through a reload of the chrome plugin", async () => {
		await browser.open(`${origin}/coding/${session}`);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')`);
		await browser.evaluate("window.p3Marker = 1");
		const file = join(builtIn, "chrome", "top-bar.tsx");
		const source = await readFile(file, "utf8");
		await writeFile(
			file,
			source.replace(
				"<span className={styles.wordmark}>Pi</span>",
				"<span className={styles.wordmark}>Pi edited</span>",
			),
		);
		await until(t.plugins, (state) => state.dirty.length > 0, within("the edit seen", context, 10_000));
		await t.apply(context);
		await browser.wait(`document.querySelector("[data-top-bar]")?.textContent.includes("Pi edited")`);
		assert.equal(await browser.evaluate("window.p3Marker"), 1, "the page did not load again");
		await browser.wait(`document.querySelector('[data-transcript="writer"]')`);
		await browser.wait(`document.querySelector('[data-connection="connected"]')`);
	});

	it("applies a plugin whose web contract is newer than the page's base, without an error", async () => {
		// The deployment's bug (2026-11-23): an apply brought a new view token in the sessions plugin's web contract; the
		// coding app took it from `/v1/web`, which is the page's base, built at the server's start: `undefined` there,
		// and the coding page stopped with an error. Here a new view and its use are applied over the running page.
		await browser.open(`${origin}/coding/${session}`);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')`);
		await browser.evaluate("window.p3Marker = 2");
		const edit = async (path: string, change: (source: string) => string) => {
			const file = join(builtIn, ...path.split("/"));
			await writeFile(file, change(await readFile(file, "utf8")));
		};
		await edit(
			"sessions/contract.web.tsx",
			(source) =>
				`${source}\n/** A view new since the page's base, for the test. */\nexport const ProbeView = defineView<Record<string, never>>("sessions.probe");\n`,
		);
		await edit("sessions/web.tsx", (source) =>
			source
				.replace("	MyThingsView,\n", "	MyThingsView,\n	ProbeView,\n")
				.replace(
					"		viewOf(MyThingsView, MyThingsList),",
					'		viewOf(MyThingsView, MyThingsList),\n		viewOf(ProbeView, () => <p data-probe="">probe</p>),',
				),
		);
		await edit("coding/open-session.tsx", (source) =>
			source
				.replace("	PaneLayoutView,", "	PaneLayoutView,")
				.replace(
					'from "../sessions/contract.web.tsx";',
					'from "../sessions/contract.web.tsx";\nimport { ProbeView } from "../sessions/contract.web.tsx";',
				)
				.replace(
					"	const Layout = useView(PaneLayoutView);",
					"	const Layout = useView(PaneLayoutView);\n	const Probe = useView(ProbeView);",
				)
				.replace(
					"<div className={styles.panes}>",
					"<div className={styles.panes}>\n				{Probe === undefined ? null : <Probe />}",
				),
		);
		await until(t.plugins, (state) => state.dirty.length >= 2, within("the edits seen", context, 10_000));
		await t.apply(context);
		await browser.wait(`document.querySelector("[data-probe]")`);
		assert.equal(await browser.evaluate("window.p3Marker"), 2, "the page did not load again");
		assert.equal(await browser.evaluate(`document.querySelector("[data-app-error]") === null`), true);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')`);
	});

	it("gives an app without the bar one corner button, and keeps the bar above an app that throws", async () => {
		// Two apps of the owner's own root: one with the corner button, one whose page throws.
		const files: Readonly<Record<string, string>> = {
			"corner.server.ts": appServer("corner", "Corner", "button"),
			"corner.web.tsx": appPage("corner", '<p data-corner-page="">A page without the bar</p>'),
			"broken.server.ts": appServer("broken", "Broken", "bar"),
			"broken.web.tsx": appPage("broken", '{(() => { throw new Error("the page broke"); })()}'),
		};
		for (const [name, source] of Object.entries(files)) await writeFile(join(t.userRoot, name), source);
		// New plugins change the set (a discovery), they are not dirty yet.
		await until(t.plugins, (state) => state.set, within("the new plugins seen", context, 10_000));
		await t.apply(context);
		await browser.open(`${origin}/corner`);
		await browser.wait(`document.querySelector("[data-corner-page]")`);
		await browser.wait(`document.querySelector("[data-corner-menu]") && !document.querySelector("[data-top-bar]")`);
		await browser.screenshot(join(SHOTS, "08-corner-desktop.png"));
		await browser.click("[data-corner-menu]");
		await browser.wait(`document.querySelector('[data-corner-popup] [data-app="coding"]')`);
		await browser.click('[data-corner-popup] [data-app="broken"]');
		await browser.wait(`location.pathname === "/broken"`);
		await browser.wait(`document.querySelector("[data-app-error]")?.textContent.includes("the page broke")`);
		await browser.wait(`document.querySelector("[data-app-switcher]")?.textContent === "Broken"`);
		await browser.screenshot(join(SHOTS, "09-app-error-desktop.png"));
		await browser.click("[data-app-switcher]");
		await browser.click('[data-app-menu] [data-app="coding"]');
		await browser.wait(`location.pathname === "/coding" && document.querySelector("[data-session-list]")`);
	});

	it("renders an app that asks for a view the page's base lacks, reporting it once instead of failing", async () => {
		// A plugin built against a newer API than the page's base: a view token the base does not have is `undefined`
		// here (`useView` of `undefined` stands for it).
		await writeFile(join(t.userRoot, "skew.server.ts"), appServer("skew", "Skew", "bar"));
		await writeFile(
			join(t.userRoot, "skew.web.tsx"),
			[
				'import { defineFacet } from "@earendil-works/p3/v1";',
				'import { AppPages, useView, type ViewToken } from "@earendil-works/p3/v1/web";',
				"function Page() {",
				"	const Missing = useView(undefined as unknown as ViewToken<Record<string, never>>);",
				'	return <main><p data-skew="">Still here</p>{Missing === undefined ? <p data-skew-missing="">No view</p> : <Missing />}</main>;',
				"}",
				'export default defineFacet((_host, self) => self.contribute(AppPages, { app: "skew", Page }));',
			].join("\n"),
		);
		await until(t.plugins, (state) => state.set, within("the new plugin seen", context, 10_000));
		await t.apply(context);
		const reported = () => browser.console.filter((line) => line.includes(MISSING_VIEW)).length;
		const before = reported();
		await browser.open(`${origin}/skew`);
		await browser.wait(`document.querySelector("[data-skew]")?.textContent === "Still here"`);
		await browser.wait(`document.querySelector("[data-skew-missing]")`);
		assert.equal(await browser.evaluate(`document.querySelector("[data-app-error]") === null`), true);
		await browser.wait(`document.querySelector("[data-app-switcher]")?.textContent === "Skew"`);
		await eventually(reported, (count) => count === before + 1);
		// Once per mount: rendering again reports nothing more.
		await browser.evaluate("dispatchEvent(new Event('resize'))");
		assert.equal(reported(), before + 1);
		// The rest of the page goes on.
		await browser.click("[data-app-switcher]");
		await browser.click('[data-app-menu] [data-app="coding"]');
		await browser.wait(`location.pathname === "/coding" && document.querySelector("[data-session-list]")`);
	});

	it("lets an invited person in, added to the session in its view", async () => {
		await browser.open(`${origin}/coding/${session}`);
		await browser.click("[data-person-menu]");
		await browser.click("[data-invite-open]");
		await browser.type("[data-invite-name]", "Ada");
		await browser.click('[data-invite] button[type="submit"]');
		await browser.wait(`document.querySelector("[data-invite-link]")?.value.includes("/_p3/invite#")`);
		await browser.settled("[data-invite]");
		await browser.screenshot(join(SHOTS, "10-invite-desktop.png"));
		const link = await browser.evaluate<string>(`document.querySelector("[data-invite-link]").value`);
		await browser.click('[data-invite] button[aria-label="Close"]');
		// The owner adds Ada to the session in its members ("Share").
		await browser.click("[data-members-open]");
		await browser.wait(
			`document.querySelector('[data-add-member] [data-field="person"]')?.textContent.includes("Ada")`,
		);
		await press("[data-add-member] button:not([data-field])");
		await browser.wait(`document.querySelector("[data-member]")?.textContent.includes("Ada")`);
		await browser.screenshot(join(SHOTS, "11-members-desktop.png"));
		ada = await browser.evaluate<string>(`document.querySelector("[data-member]").dataset.member`);
		// Ada opens her link in a browser of her own (this one, signed out).
		await browser.signOut();
		await browser.open(link);
		await browser.wait(`location.pathname === "/coding"`);
		await browser.wait(`document.querySelector("[data-person-menu]")?.textContent.includes("Ada")`);
		await browser.wait(`document.querySelector('[data-session="${session}"]')`);
		await browser.click(`[data-session="${session}"]`);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')`);
		await browser.wait(
			`[...document.querySelectorAll('[data-entry="assistant"]')].some((e) => e.textContent.includes("faux model"))`,
		);
		await browser.screenshot(join(SHOTS, "12-person-desktop.png"));
	});

	it("lets a person who writes bring a notebook of their own, which the owner sees as theirs, and remove it", async () => {
		// Ada makes a notebook of hers into the session (the sheet's "Add" of an owned thing is the page's next step:
		// here through `SessionThings`, as her page would).
		const adas = await t.client(context, { kind: "person", id: ada, name: "Ada" });
		// Notes are content: made in the session (nobody's), then kept to her.
		const adasThings = await writerOf(adas, session);
		const adasNotes = await adasThings.create({ kind: "notes.notes", name: "Ada's notes" }, context);
		await adasThings.keep({ thing: adasNotes, owner: { kind: "person", id: ada } }, context);
		// She reads herself as "You" among the session's members.
		await browser.click("[data-members-open]");
		await browser.settled("[data-members-dialog]");
		await browser.wait(`document.querySelector('[data-member="${ada}"]')?.textContent.includes("You")`);
		assert.equal(await browser.evaluate(`document.querySelector("[data-add-member]") === null`), true);
		await press('[data-members-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-members-dialog]") === null`);
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		// She reads the kinds by their titles; the coding tools have no pane to open, and nothing she may do to them.
		await browser.wait(`document.querySelector('[data-thing="tools.coding"]')?.textContent.includes("Coding tools")`);
		assert.equal(
			await browser.evaluate(`document.querySelector('[data-thing="tools.coding"] [data-row-open]') === null`),
			true,
		);
		assert.deepEqual(await menuItems('[data-thing="tools.coding"]'), []);
		const hers = `[data-thing="notes.notes"][data-by="person:${ada}"]`;
		await browser.wait(`document.querySelector('${hers}')?.textContent.includes("Yours")`);
		await browser.screenshot(join(SHOTS, "13-bring-person-desktop.png"));
		// She opens it as a pane beside the transcript and writes in it: she writes in the session and the default
		// options say edit.
		const notebook = await browser.evaluate<string>(`document.querySelector('${hers}').dataset.thingId`);
		const pane = `[data-pane-body][data-pane="${notebook}"]`;
		await press(`${hers} [data-row-open]`);
		await browser.wait(`document.querySelector("[data-things-dialog]") === null`);
		await browser.wait(`location.pathname === "/coding/${session}/${notebook}"`);
		await browser.wait(`document.querySelector('${pane} [data-notes="editor"]')`);
		await browser.wait(`document.querySelector('[data-pane-body][data-pane="transcript"] [data-transcript]')`);
		await press(`${pane} [data-note-new]`);
		await browser.type(`${pane} [data-note-new]`, "Buy more coffee");
		await press(`${pane} [data-note-add]`);
		await browser.wait(`document.querySelector('${pane} [data-note-text]')?.textContent === "Buy more coffee"`);
		await browser.wait(`document.querySelector('${pane} [data-note]')?.textContent.includes("You")`);
		await shots("notes-01-editor-desktop");
		// The owner, in a browser of their own, sees them as Ada's (in the dialog and in the pane).
		const adaCookie = await browser.cookie(origin);
		await browser.signOut();
		await browser.signIn(origin, await t.cookie(context));
		await browser.size(PHONE);
		await browser.open(`${origin}/coding/${session}`);
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(`document.querySelector('${hers}')?.textContent.includes("Ada's")`);
		// The owner sets the notebook's options: everyone reads only, the agent writes.
		await menu(hers, "options");
		const panel = `${hers} [data-thing-options]`;
		await browser.wait(
			`document.querySelector('${panel} [data-option="edit"]')?.getAttribute("aria-checked") === "true"`,
		);
		await press(`${panel} [data-option="edit"]`);
		await press(`${panel} [data-options-save]`);
		await pick(`${panel} [data-field="whose"]`, "agent", "The agent");
		await browser.wait(`document.querySelector('${panel} [data-options-source="default"]')`);
		await browser.wait(
			`document.querySelector('${panel} [data-option="edit"]')?.getAttribute("aria-checked") === "false"`,
		);
		await press(`${panel} [data-option="edit"]`);
		await press(`${panel} [data-options-save]`);
		await browser.wait(`document.querySelector('${panel} [data-options-source="own"]')`);
		await shots("notes-02-options-phone");
		// The owner, without options of their own, reads it only now too: in its pane, full screen on the phone.
		await press(`${hers} [data-row-open]`);
		await browser.wait(`document.querySelector('${pane} [data-notes="reader"]')`);
		await browser.wait(`document.querySelector('${pane} [data-note]')?.textContent.includes("Ada")`);
		// The agent writes a note through its scripted answer; it appears in the owner's open view.
		script = [
			...script,
			{
				when: "@note",
				reply: [
					{
						kind: "tool",
						name: "notes_write",
						args: JSON.stringify({ notebook, text: "Coffee is on the list." }),
					},
				],
			},
			{ when: "Added note", reply: [{ kind: "text", text: "Noted." }] },
		];
		await (await writerOf(owner, session)).setOptions(
			{ thing: faux, for: { kind: "everyone" }, options: { provider: "faux", script, tool: true } },
			context,
		);
		const transcript = await owner.get(Transcript, { session }, context);
		if (transcript.variant !== "writer") return assert.fail(transcript.variant);
		await transcript.send({ text: "@note", requestId: "page-note" }, context);
		await browser.wait(
			`[...document.querySelectorAll('${pane} [data-note]')].some((e) => e.textContent.includes("Coffee is on the list.") && e.textContent.includes("The agent"))`,
		);
		await shots("notes-03-agent-phone");
		transcript.release();
		// The owner brings a notebook of theirs too.
		const ownersThings = await writerOf(owner, session);
		const madeNotes = await ownersThings.create({ kind: "notes.notes", name: "Owner's notes" }, context);
		await ownersThings.keep({ thing: madeNotes, owner: { kind: "person", id: ownerId } }, context);
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		const owners = `[data-thing="notes.notes"][data-by="person:${ownerId}"]`;
		await browser.wait(`document.querySelector('${owners}')?.textContent.includes("Yours")`);
		ownerNotes = await browser.evaluate<string>(`document.querySelector('${owners}').dataset.thingId`);
		await browser.screenshot(join(SHOTS, "14-bring-owner-phone.png"));
		await press('[data-things-dialog] button[aria-label="Close"]');
		// Ada's pane of her notebook is read only now, with the agent's note; she sees the owner's notes as theirs,
		// without a way to withdraw them, and withdraws her own: its pane goes with it.
		await browser.signOut();
		await browser.signIn(origin, adaCookie);
		await browser.size(DESKTOP);
		await browser.open(`${origin}/coding/${session}/${notebook}`);
		await browser.wait(`document.querySelector('${pane} [data-notes="reader"]')`);
		await browser.wait(`document.querySelector('${pane}')?.textContent.includes("Coffee is on the list.")`);
		assert.equal(await browser.evaluate(`document.querySelector('${pane} [data-note-new]') === null`), true);
		await shots("notes-04-reader-desktop");
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(`document.querySelector('${owners}')?.textContent.includes("${ownerName}'s")`);
		assert.deepEqual(await menuItems(owners), []);
		await menu(hers, "remove");
		await browser.wait(`document.querySelector('${hers}') === null`);
		await browser.screenshot(join(SHOTS, "15-withdrawn-desktop.png"));
		await press('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-session-things]") === null`);
		await browser.wait(`document.querySelector('${pane}') === null && location.pathname === "/coding/${session}"`);
	});

	it("refuses the session to a person removed from it, and every app once they are in no session of it", async () => {
		// Ada reads a second session, so Coding stays hers when the owner removes her from the first.
		const sessions = await owner.get(Sessions, {}, context);
		const location = { environment: "this-device", folder: t.dataDir };
		const second = await sessions.create(
			{ app: "coding", title: "Second", location, members: [{ kind: "person", id: ada, access: "read" }] },
			context,
		);
		await browser.wait(`document.querySelector('[data-session="${second}"]')`);
		await sessions.removeMember({ session, party: { kind: "person", id: ada } }, context);
		await browser.wait(`document.body.textContent.includes("You have no access to this session.")`);
		await browser.wait(`document.querySelector('[data-session="${session}"]') === null`);
		await browser.screenshot(join(SHOTS, "16-refused-desktop.png"));
		// Without any session of Coding, Ada may enter no app.
		await sessions.removeMember({ session: second, party: { kind: "person", id: ada } }, context);
		await browser.wait(`document.body.textContent.includes("There is no app for you on this Pi yet.")`);
		await browser.wait(`document.querySelector("[data-top-bar]")`);
		await browser.size(PHONE);
		await browser.screenshot(join(SHOTS, "17-no-app-phone.png"));
	});

	it("lays the panes out: a thing opens beside the transcript, a tab dragged to an edge splits, dividers resize", async () => {
		// The owner, on a desktop, with a canvas beside their notebook; their layout of this session starts over.
		const canvas = await (await writerOf(owner, session)).create({ kind: CanvasKind.name }, context);
		await browser.signOut();
		await browser.signIn(origin, await t.cookie(context));
		await browser.size(DESKTOP);
		// Cleared from a page of the origin that runs no app (the base's hash), so no open session writes it back.
		await browser.open(`${origin}/_chord/web/base`);
		await browser.evaluate("localStorage.clear()");
		await browser.open(`${origin}/coding/${session}`);
		await browser.wait(`document.querySelectorAll("[data-pane-group]").length === 1`);
		// Opening the notebook from the dialog splits a group off to the right of the transcript's.
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await press(`[data-thing-id="${ownerNotes}"] [data-row-open]`);
		await browser.wait(`location.pathname === "/coding/${session}/${ownerNotes}"`);
		await browser.wait(`document.querySelectorAll("[data-pane-group]").length === 2`);
		await browser.wait(`document.querySelector('[data-pane-body][data-pane="${ownerNotes}"] [data-notes]')`);
		// The canvas joins the notebook's group, active there.
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await press(`[data-thing-id="${canvas}"] [data-row-open]`);
		await browser.wait(`document.querySelector('[data-pane-body][data-pane="${canvas}"]')`);
		// The dialog's backdrop fades out over the panes: a drag waits until it is gone.
		await browser.wait(
			`document.querySelector("[data-things-dialog]") === null && document.querySelector("[data-ending-style]") === null`,
		);
		const right = `[data-pane-group]:has([data-pane-tab="${canvas}"])`;
		await browser.wait(`document.querySelector('${right} [data-pane-tab="${ownerNotes}"]')`);
		await browser.screenshot(join(SHOTS, "18-panes-desktop.png"));
		// The notebook's tab dragged to the right edge of its group's pane: a third column.
		const body = await browser.box(`${right} [data-pane-body]`);
		await browser.drag(
			`[data-pane-tab="${ownerNotes}"] [role="tab"]`,
			body.x + body.width - 8,
			body.y + body.height / 2,
			// Held at the edge: the half it would take is shown.
			async () => {
				await browser.wait(`document.querySelector('${right} [data-drop="right"]')`);
				await browser.screenshot(join(SHOTS, "19-drop-edge-desktop.png"));
			},
		);
		await browser.wait(`document.querySelectorAll("[data-pane-group]").length === 3`);
		const shares = () =>
			browser.evaluate<string[]>(
				`[...document.querySelectorAll("[data-pane-layout] > div > [data-share]")].map((e) => e.dataset.share)`,
			);
		assert.deepEqual(await shares(), ["0.500", "0.250", "0.250"]);
		await browser.wait(
			`[...document.querySelectorAll("[data-pane-group]")].at(-1).querySelector('[data-pane-tab="${ownerNotes}"]')`,
		);
		// The first divider dragged right: the transcript's column grows, the next one shrinks.
		const divider = await browser.box('[data-pane-divider="0"]');
		await browser.drag(
			'[data-pane-divider="0"]',
			divider.x + divider.width / 2 + 120,
			divider.y + divider.height / 2,
		);
		await browser.wait(
			`document.querySelector("[data-pane-layout] > div > [data-share]")?.dataset.share !== "0.500"`,
		);
		const resized = await shares();
		assert.ok(Number(resized[0]) > 0.55 && Number(resized[1]) < 0.2, resized.join());
		await shots("19-panes-split-desktop");
		// A page load keeps the layout (the browser's storage).
		await browser.open(`${origin}/coding/${session}/${ownerNotes}`);
		await browser.wait(`document.querySelectorAll("[data-pane-group]").length === 3`);
		assert.deepEqual(await shares(), resized);
	});

	it("shows one pane at a time on a phone: chips to tap and close, a swipe to the neighbour", async () => {
		await browser.size(PHONE);
		await browser.open(`${origin}/coding/${session}/${ownerNotes}`);
		await browser.wait(`document.querySelector('[data-pane-layout="chips"]')`);
		const chips = () =>
			browser.evaluate<string[]>(
				`[...document.querySelectorAll("[data-pane-chip]")].map((e) => e.dataset.paneChip)`,
			);
		// Every pane of the tree, in its order: the transcript, the canvas, the notebook.
		await browser.wait(`document.querySelectorAll("[data-pane-chip]").length === 3`);
		const [, canvas] = await chips();
		assert.deepEqual(await chips(), ["transcript", canvas, ownerNotes]);
		await browser.wait(`document.querySelector('[data-pane-chip="${ownerNotes}"][data-active]')`);
		assert.equal(await browser.evaluate("document.querySelectorAll('[data-pane-body]').length"), 1);
		await browser.settled("[data-pane-body]");
		await shots("20-chips-phone");
		// A tap on the transcript's chip shows it.
		await browser.click('[data-pane-chip="transcript"] [role="tab"]');
		await browser.wait(`location.pathname === "/coding/${session}"`);
		await browser.wait(`document.querySelector('[data-pane-body][data-pane="transcript"] [data-transcript]')`);
		// A swipe to the left goes to the next pane, the canvas.
		const body = await browser.box("[data-pane-body]");
		await browser.swipe(body.x + body.width * 0.8, body.y + 120, body.x + body.width * 0.2, body.y + 130);
		await browser.wait(`location.pathname === "/coding/${session}/${canvas}"`);
		await browser.wait(`document.querySelector('[data-pane-chip="${canvas}"][data-active]')`);
		await browser.settled("[data-pane-body]");
		await shots("21-swiped-phone");
		// Its chip's × closes the canvas; the notebook, its neighbour in its group, shows.
		await browser.click(`[data-pane-close="${canvas}"]`);
		await browser.wait(`document.querySelectorAll("[data-pane-chip]").length === 2`);
		await browser.wait(`location.pathname === "/coding/${session}/${ownerNotes}"`);
		// The same tree on the desktop: the canvas is gone there too.
		await browser.size(DESKTOP);
		await browser.wait(`document.querySelector('[data-pane-layout="split"]')`);
		await browser.wait(`document.querySelector('[data-pane-tab="${canvas}"]') === null`);
		await browser.wait(`document.querySelectorAll("[data-pane-group]").length === 2`);
	});

	it("names things: two canvases made and renamed show as two tabs, and a tab follows a rename", async () => {
		await browser.size(DESKTOP);
		await browser.open(`${origin}/coding/${session}`);
		/** Makes a canvas with the sheet's "+" (named "Canvas") and renames it `name`; answers its id. */
		const add = async (name: string): Promise<string> => {
			await browser.click("[data-things-open]");
			await browser.settled("[data-things-dialog]");
			const before = await thingIds("canvas.board");
			await press("[data-add-open]");
			await browser.click('[data-add-popup] [data-new-kind="canvas.board"]');
			await browser.wait(
				`[...document.querySelectorAll('[data-thing="canvas.board"]')].some((e) => !${JSON.stringify(before)}.includes(e.dataset.thingId))`,
			);
			const made = (await thingIds("canvas.board")).find((id) => !before.includes(id))!;
			await rename(`[data-thing-id="${made}"]`, name);
			return made;
		};
		/** Opens thing `thing` from the dialog as a pane. */
		const open = async (thing: string): Promise<void> => {
			await press(`[data-thing-id="${thing}"] [data-row-open]`);
			await browser.wait(
				`document.querySelector("[data-things-dialog]") === null && document.querySelector("[data-ending-style]") === null`,
			);
		};
		const plan = await add("Plan");
		await open(plan);
		const sketches = await add("Sketches");
		await open(sketches);
		await browser.wait(`document.querySelector('[data-pane-tab="${plan}"]')?.textContent === "Plan"`);
		await browser.wait(`document.querySelector('[data-pane-tab="${sketches}"]')?.textContent === "Sketches"`);
		// The owner renames the plan in place; its tab follows.
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		const planRow = `[data-thing-id="${plan}"]`;
		await menu(planRow, "rename");
		await browser.wait(`document.querySelector('${planRow} [data-field="rename"]')?.value === "Plan"`);
		// Emptied as a person would (`type` clicks into the field first, which would undo a selection).
		await browser.evaluate(
			`(() => { const input = document.querySelector('${planRow} [data-field="rename"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		await browser.type(`${planRow} [data-field="rename"]`, "Roadmap");
		await browser.wait(`document.querySelector('${planRow} [data-field="rename"]')?.value === "Roadmap"`);
		await browser.screenshot(join(SHOTS, "22-rename-desktop.png"));
		await press(`${planRow} [data-rename-save]`);
		await browser.wait(`document.querySelector('${planRow} [data-thing-name]')?.textContent === "Roadmap"`);
		await browser.screenshot(join(SHOTS, "23-named-things-desktop.png"));
		await press('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector('[data-pane-tab="${plan}"]')?.textContent === "Roadmap"`);
		await shots("24-named-tabs-desktop");
		await browser.size(PHONE);
		await browser.wait(`document.querySelector('[data-pane-chip="${plan}"]')?.textContent.includes("Roadmap")`);
		await browser.wait(`document.querySelector('[data-pane-chip="${sketches}"]')?.textContent.includes("Sketches")`);
		await browser.settled("[data-pane-body]");
		await shots("25-named-chips-phone");
	});

	it("makes a person's thing in My things through its creation view, in all their sessions, then gives it away and deletes it", async () => {
		await browser.size(DESKTOP);
		// A session that follows the owner who makes it.
		const sessions = await owner.get(Sessions, {}, context);
		const location = { environment: "this-device", folder: t.dataDir };
		const mail = await sessions.create({ app: "coding", title: "Mail", location }, context);
		await browser.open(`${origin}/coding/${mail}`);
		await browser.wait(`document.querySelector("[data-things-open]")`);
		// My things: "New", the faux inbox (a kind people make), named, made through its own sign-in step.
		await openMyThings();
		await press("[data-make-open]");
		await browser.wait(
			`document.querySelector('[data-make-thing] [data-field="make-kind"]')?.textContent.includes("Faux inbox")`,
		);
		// Whom it may be made for: the owner and, by name, the Pi.
		await press('[data-make-thing] [data-field="make-owner"]');
		await browser.wait(`document.querySelector('[data-choice="pi"]')?.textContent === "The Pi"`);
		await browser.click(`[data-choice="person:${ownerId}"]`);
		await press('[data-make-thing] [data-field="name"]');
		await browser.type('[data-make-thing] [data-field="name"]', "Inbox");
		await shots("29-make-thing-desktop");
		await press("[data-faux-sign-in]");
		const row = `[...document.querySelectorAll("[data-my-thing]")].find((e) => e.querySelector("[data-thing-name]")?.textContent === "Inbox")`;
		await browser.wait(`${row}?.querySelector("[data-whose]")?.textContent === "Faux inbox · Yours"`);
		const inbox = await browser.evaluate<string>(`${row}.dataset.myThing`);
		const mine = `[data-my-thing="${inbox}"]`;
		// The sign-in its creation view handed over reached the kind's create hook.
		assert.equal(await signInOf(inbox), "faux-sign-in");
		// "In all my sessions": on for a thing made in My things; switched off and on again.
		const everywhere = (on: boolean) =>
			browser.wait(`document.querySelector('${mine} [data-everywhere]')?.getAttribute("aria-checked") === "${on}"`);
		await everywhere(true);
		await press(`${mine} [data-everywhere]`);
		await everywhere(false);
		await press(`${mine} [data-everywhere]`);
		await everywhere(true);
		// "Used in": no session links it, yet every session that follows its owner has it.
		await menu(mine, "uses");
		await browser.wait(
			`document.querySelector('${mine} [data-followers]')?.textContent === "It is in every session that follows you."`,
		);
		assert.equal(
			await browser.evaluate(
				`document.querySelector('${mine} [data-thing-uses]').textContent.includes("No session.")`,
			),
			false,
		);
		await shots("30-my-inbox-desktop");
		await closeMyThings();
		// The following session has it, from whom it follows.
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(
			`document.querySelector('[data-thing-id="${inbox}"][data-by="followed"] [data-whose]')?.textContent === "From you"`,
		);
		await shots("31-followed-inbox-desktop");
		// "One of mine…": the board kept in the first session, found by the start of its name and linked here.
		await press("[data-add-open]");
		await browser.click("[data-add-popup] [data-add-existing-open]");
		await browser.settled("[data-add-existing]");
		await press('[data-add-existing] [data-field="search"]');
		await browser.type('[data-add-existing] [data-field="search"]', "Bo");
		await browser.wait(`document.querySelector('[data-existing="${boardId}"]')`);
		await shots("32-one-of-mine-desktop");
		await browser.click(`[data-existing="${boardId}"] [data-row-open]`);
		await browser.wait(`document.querySelector("[data-add-existing]") === null`);
		await browser.wait(
			`document.querySelector('[data-thing-id="${boardId}"] [data-whose]')?.textContent === "Yours"`,
		);
		await press('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-things-dialog]") === null`);
		// It appeared in the session while the page was open: it opened by itself, beside the transcript, which keeps
		// the focus.
		await browser.wait(`document.querySelector('[data-pane-tab="${boardId}"]')`);
		assert.equal(await browser.evaluate("location.pathname"), `/coding/${mail}`);
		await browser.settled("[data-pane-layout]");
		await shots("33-opened-by-itself-desktop");
		// Given away to the Pi.
		await openMyThings();
		await menu(mine, "give");
		await press(`${mine} [data-field="keeper"]`);
		await browser.wait(`document.querySelector('[data-choice="pi"]')?.textContent === "The Pi"`);
		await browser.click('[data-choice="pi"]');
		await press(`${mine} [data-give-save]`);
		await browser.wait(`document.querySelector('${mine} [data-whose]')?.textContent === "Faux inbox · The Pi's"`);
		// Deleted, after a second press: gone from My things, from the session, and its sign-in with it.
		await menu(mine, "delete");
		await press(`${mine} [data-delete-confirm]`);
		await browser.wait(`document.querySelector('${mine}') === null`);
		assert.equal(await signInOf(inbox), null);
		await closeMyThings();
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(`document.querySelector('[data-thing-id="${inbox}"]') === null`);
		await press('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-things-dialog]") === null`);
	});

	it("leaves nothing reported on the server, and no error in the page but the broken app's", () => {
		assert.deepEqual(t.errors, []);
		// The broken app's error, and the one report of a view the base lacks (the skew app's): nothing else.
		assert.deepEqual(
			browser.console.filter((line) => !line.includes("the page broke") && !line.includes(MISSING_VIEW)),
			[],
		);
	});
});

/** What `useView` reports for a view token the page's base does not have. */
const MISSING_VIEW = "a view this page's base does not have";

/** A single-file plugin's server facet saying app `id` exists, with `chrome`. */
function appServer(id: string, title: string, chrome: "bar" | "button"): string {
	return [
		'import { defineFacet } from "@earendil-works/p3/v1";',
		'import { Apps } from "@earendil-works/p3/v1/server";',
		`export default defineFacet((_host, self) => self.contribute(Apps, ${JSON.stringify({ id, title, chrome })}));`,
	].join("\n");
}

/** A single-file plugin's web facet giving app `id` a page that renders `body` (JSX). */
function appPage(id: string, body: string): string {
	return [
		'import { defineFacet } from "@earendil-works/p3/v1";',
		'import { AppPages } from "@earendil-works/p3/v1/web";',
		`function Page() { return <main>${body}</main>; }`,
		`export default defineFacet((_host, self) => self.contribute(AppPages, { app: ${JSON.stringify(id)}, Page }));`,
	].join("\n");
}

/** `client`'s writer of session `session`'s things. */
async function writerOf(client: Host<P3Principal>, session: string) {
	const things = await client.get(SessionThings, { session }, context);
	if (things.variant !== "writer") throw new Error(`a ${things.variant} of the session's things`);
	return things;
}
