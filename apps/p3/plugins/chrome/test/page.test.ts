// The page in a real browser (only when asked: `P3_BROWSER_TESTS=1` with `CHROMIUM_BIN`), on p3's real server with a
// copy of the built-in plugins the test edits and the tests' kinds (a note without a view, a wall that takes the page):
// `/` goes to the person's topmost workspace; the navigator shows the person, the workspaces and the open one's four
// groups; a plain workspace opens in its Settings view (on a phone its navigator first), whose who-may writes one grant
// row per checkbox (given, reset, withheld) and folds the Make ticks into one column; the add-thing picker groups by
// plugin and previews a kind's default grants, which the person may untick; a thing with a view opens in it, one
// without in its Settings view; a thing from above is greyed and a hidden one folded; a view that takes the whole page
// keeps only the corner button; the invite dialog makes links that sign a new member or guest in and put a signed-in
// person in; `/me` is the person's own page; every kind and tick label shows in words; a session is removed from its
// Settings view, also when addressed as a thing of its parent; a session made through the picker opens from the
// navigator in its transcript view, streams a scripted answer, and shows a person with Read only the transcript with no
// way to send; who may's access choice and Make column, a write from another page shown live, its cards on a phone; the
// switches for things and people from above; no link offered without Link; a person present only below sees nothing of
// the workspaces above; `?view=` kept through the gear and Back and through pane focus, and a session's pane back when
// its thing is shown again; the add dialog's draft kept through an apply and dropped on close, one make for two
// activations of Add, Add disabled when Make of the chosen kind goes, a default unticked and ticked again written; the
// phone's screens; a reload of the chrome, things and transcript plugins keeps the open page and unsent work; an apply
// whose web contracts are newer than the page's base leaves it working, and a component the base lacks is reported
// once. Screenshots at the phone's and the desktop's size, light and dark, go to `/tmp/p3-base/shots/` (`P3_SHOTS`
// names another directory).

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, type Host, Me, type P3Principal, People, until } from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { scriptFaux } from "../../../test/support.ts";
import { eventually, within } from "../../../test/until.ts";
import { SignIns } from "../../sign-in/contract.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import { ThingKindsView } from "../../things/kind.ts";
import { Workspace } from "../../things/workspace.ts";
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
	/** The Sketch, a canvas linked in Pi, made through the picker. */
	let sketch: string;
	/** Family, a workspace in Pi, made through the picker. */
	let family: string;
	/** Ada, invited and put into Pi (her person id). */
	let ada: string;

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
		// Two frames for whatever follows the scroll (a popup's position) before the click looks where to land.
		await browser.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
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
		// A thing with no view of its own shows its Settings view, with no gear to the same view (Mario, on p3-base).
		await browser.wait(`document.querySelector("[data-gear]") === null`);
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
		sketch = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === "Sketch").dataset.navThing`,
		);
		await press(`[data-nav-thing="${sketch}"]`);
		await browser.wait(`document.querySelector('section[aria-label="Canvas"]')`);
		await browser.wait(`document.querySelector("[data-gear]")`);
		await shots("06-canvas-desktop");
		await press("[data-gear]");
		await browser.wait(`location.pathname.endsWith("/settings")`);
		await browser.wait(`document.querySelector('[data-settings="${sketch}"]')`);
		await browser.wait(`document.querySelector("[data-gear]") === null`);
	});

	it("opens Pi's Files, Terminals and machine in their views, on a desktop and a phone (ERNDL-1172-1174)", async () => {
		/** The navigator's entry named `name` in Pi: its thing's id. */
		const entry = (name: string) =>
			browser.evaluate<string>(
				`[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === ${JSON.stringify(name)})?.dataset.navThing`,
			);
		await press(`[data-nav-workspace="${pi}"]`);
		await browser.wait(`[...document.querySelectorAll('[data-nav-thing]')].some((e) => e.textContent === "Files")`);
		const views = [
			// The owner has Edit by the owner flag: the browser's writer, on this device's root.
			[await entry("Files"), 'section[aria-label="Files"][data-files="writer"]', "files"],
			[await entry("Terminals"), 'section[aria-label="Terminals"][data-terminals]', "terminals"],
			[await entry(hostname()), '[data-machine="ready"]', "machine"],
		] as const;
		for (const [thing, shown, name] of views) {
			await browser.open(`${origin}/w/${pi}/t/${thing}`);
			await browser.wait(`document.querySelector(${JSON.stringify(shown)})`);
			await shots(`07-${name}-desktop`);
			await browser.size(PHONE);
			await browser.wait(`document.querySelector(${JSON.stringify(shown)})?.offsetParent !== null`);
			await shots(`07-${name}-phone`);
			await browser.size(DESKTOP);
		}
		await browser.open(`${origin}/w/${pi}`);
	});

	// Opus, round 5 (S4): the views as a person with Browse and Watch only, and as one with neither (the kinds' default).
	it("shows Files and Terminals to a person with Browse and Watch only, read only, and nothing to one without", async () => {
		await browser.wait(
			`["Files", "Terminals"].every((name) => [...document.querySelectorAll('[data-nav-thing]')].some((e) => e.textContent === name))`,
		);
		const [files, terminals] = await Promise.all(
			["Files", "Terminals"].map((name) =>
				browser.evaluate<string>(
					`[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === ${JSON.stringify(name)})?.dataset.navThing`,
				),
			),
		);
		/** A person put into Pi, with Browse and Watch (`ticks`) or none, and their browser cookie. */
		const personWith = (name: string, ticks: boolean) =>
			t.host.root(async (ctx) => {
				const things = await ctx.get(ThingsStore, {});
				const by = { kind: "plugin", plugin: "test" } as const;
				const id = await things.createPerson({ name, madeBy: by }, ctx);
				const party = { kind: "person", person: id } as const;
				await things.putParty({ workspace: pi, party, source: by }, ctx);
				if (ticks) {
					const grants = [
						{ workspace: pi, thing: files!, party, tick: "browse", gives: true },
						{ workspace: pi, thing: terminals!, party, tick: "watch", gives: true },
					];
					await things.setGrants({ source: by, grants }, ctx);
				}
				const principal = { kind: "person", id, name } as const;
				const issued = await (await ctx.get(SignIns, {})).issue({ principal, kind: "browser", label: "test" }, ctx);
				return issued.cookie.split(";")[0]!;
			}, context);
		const other = await Browser.start();
		try {
			await other.signIn(origin, await personWith("Bea", true));
			for (const size of [DESKTOP, PHONE]) {
				await other.size(size);
				await other.open(`${origin}/w/${pi}/t/${files}`);
				await other.wait(
					`document.querySelector('section[aria-label="Files"][data-files="reader"] [data-files-entry]')`,
				);
				assert.equal(
					await other.evaluate<boolean>(
						`!!document.querySelector("[data-files-upload], [data-files-rename], [data-files-remove]")`,
					),
					false,
				);
				await other.open(`${origin}/w/${pi}/t/${terminals}`);
				await other.wait(`document.querySelector('section[aria-label="Terminals"][data-terminals]')`);
				assert.equal(
					await other.evaluate<boolean>(
						`!!document.querySelector("[data-terminals-open], [data-terminal-close]")`,
					),
					false,
				);
			}
			// Not let in on either: the page says so in place of the view.
			await other.signIn(origin, await personWith("Cal", false));
			await other.open(`${origin}/w/${pi}/t/${files}`);
			await other.wait(
				`!document.querySelector('[data-files]') && document.body.textContent.includes("You have no access to this here.")`,
			);
			await other.open(`${origin}/w/${pi}/t/${terminals}`);
			await other.wait(
				`!document.querySelector('[data-terminals]') && document.body.textContent.includes("You have no access to this here.")`,
			);
		} finally {
			await other.close();
		}
	});

	// Decision 133: this device's terminals run in pi-env's daemon, the page draws them with libghostty-vt.
	it("runs a shell on this device in the Terminals view: drawn, typed into, sized, its queries answered only live", async () => {
		await browser.wait(
			`[...document.querySelectorAll('[data-nav-thing]')].some((e) => e.textContent === "Terminals")`,
		);
		const terminals = await browser.evaluate<string>(
			`[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === "Terminals")?.dataset.navThing`,
		);
		await browser.open(`${origin}/w/${pi}/t/${terminals}`);
		await press("[data-terminals-open]");
		const screen = `document.querySelector("[data-terminal-screen] [role=log]")`;
		/** Types `line` into the terminal, Enter after it, as a keyboard does (text, then the Enter key). */
		const line = async (text: string) => {
			await browser.click("[data-terminal-screen]");
			await browser.call("Input.insertText", { text });
			await browser.enter();
		};
		/** Waits until the screen shows `text`. */
		const shows = (text: string) => browser.wait(`${screen}?.textContent.includes(${JSON.stringify(text)})`);
		await browser.wait(`document.querySelector("[data-terminal-input]") !== null`);
		await line("echo page-$((6*7))");
		await shows("page-42");
		await line("printf '\\033[31mred-text\\033[0m\\n'");
		// Drawn in its colour: a span of its own (the typed command's text is one run of the default colour).
		await browser.wait(
			`[...${screen}.querySelectorAll("span")].some((e) => e.textContent.startsWith("red-text") && e.style.color !== "")`,
		);
		// The screen sized the terminal to itself: not the size it opened with.
		await line("echo size-$(stty size | tr ' ' x)");
		await browser.wait(
			`/size-\\d+x\\d+/.test(${screen}?.textContent) && !${screen}.textContent.includes("size-24x80")`,
		);
		// A query in the output replayed at attaching is not answered (it would be typed into the shell); a live one is.
		await line("printf '\\033[c'; read -rs -t 1 -d c a; echo before-$((3*3))");
		await shows("before-9");
		await browser.open(`${origin}/w/${pi}/t/${terminals}`);
		await shows("before-9");
		await line("read -rs -t 1 -n 1 x && echo stray-$((1*1)) || echo clean-$((5*5))");
		await shows("clean-25");
		await line("printf '\\033[c'; read -rs -t 2 -d c a; [ -n \"$a\" ] && echo live-$((40+2))");
		await shows("live-42");
		// A second page with Use on the same terminal: one query, one answer (Opus, Astra, round 1, S2).
		const second = await Browser.start();
		try {
			await second.signIn(origin, await t.cookie(context));
			await second.size(DESKTOP);
			await second.open(`${origin}/w/${pi}/t/${terminals}`);
			await second.wait(`${screen}?.textContent.includes("live-42")`);
			await line(
				"printf '\\033[c'; read -rs -t 2 -d c a; read -rs -t 1 -d c b; [ -n \"$b\" ] && echo replies-$((1+1)) || echo replies-$((0+1))",
			);
			await browser.wait(`/replies-[12]/.test(${screen}?.textContent)`);
			assert.equal(await browser.evaluate(`/replies-[12]/.exec(${screen}.textContent)[0]`), "replies-1");
		} finally {
			await second.close();
		}
		await browser.size(PHONE);
		// A phone's keyboard composes a word, then corrects it: the field's change is what the shell gets (Opus, round
		// 1, S4): "ehco" typed, corrected to "echo", sends three Backspaces and "cho".
		await browser.click("[data-terminal-screen]");
		await browser.call("Input.imeSetComposition", { text: "ehco", selectionStart: 4, selectionEnd: 4 });
		await browser.call("Input.insertText", { text: "echo" });
		await browser.call("Input.insertText", { text: " typed-$((2*21))" });
		await browser.enter();
		await shows("typed-42");
		await line("echo phone-$(stty size | tr ' ' x)");
		await browser.wait(`/phone-\\d+x\\d+/.test(${screen}?.textContent)`);
		const columns = await browser.evaluate<number>(`Number(/phone-\\d+x(\\d+)/.exec(${screen}.textContent)[1])`);
		assert.ok(columns < 60, `the phone's ${columns} columns`);
		await shots("terminals-phone");
		await browser.size(DESKTOP);
		await shots("terminals");
		await press("[data-terminal-close]");
		await browser.wait(
			`document.querySelector("[data-terminals]")?.textContent.includes("No terminals are open here.")`,
		);
		await browser.open(`${origin}/w/${pi}`);
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
		assert.equal(
			await browser.evaluate<string>(
				`[...document.querySelectorAll('[data-here-thing]')].find((e) => e.textContent.includes("Sketch")).dataset.hereThing`,
			),
			sketch,
		);
		family = decodeURIComponent((await browser.evaluate<string>("location.pathname")).split("/")[2]!);
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

	it("makes a guest's invite link in the invite dialog", async () => {
		await press("[data-invite-open]");
		await browser.settled("[data-invite-dialog]");
		await press('[data-invite-as="guest"]');
		await browser.type("[data-invite-name]", "Gus");
		await press("[data-invite-create]");
		await browser.wait(
			`document.querySelector("[data-invite-url]")?.value.startsWith(${JSON.stringify(`${origin}/_p3/invite#`)})`,
		);
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

	it("names every kind and its tick labels in words, never by their message keys", async () => {
		// Kinds whose plugin had no web facet brought no texts to the page: Who may showed `tickRead` (video2).
		const kinds = await until(
			(await owner.get(ThingKindsView, {}, context)).kinds,
			(found) => Object.keys(found).length > 0,
			context,
		);
		const keys = new Set(Object.values(kinds).flatMap((kind) => kind.ticks.map((tick) => tick.label.key)));
		const shown = () =>
			browser.evaluate<string[]>(
				`[...document.querySelectorAll("[data-who-may] th, [data-make-popup]"), document.querySelector("main")].map((e) => e.textContent.trim())`,
			);
		const inWords = (texts: readonly string[], at: string) => {
			for (const text of texts) {
				assert.ok(!keys.has(text), `${at} shows the message key ${text}`);
				assert.ok(!text.includes("A thing"), `${at} names a kind without its title: ${text}`);
			}
		};
		await browser.size(DESKTOP);
		await browser.open(`${origin}/w/${pi}/settings`);
		await press('[data-settings-tab="what"]');
		await browser.wait(`document.querySelectorAll("[data-here-thing]").length > 0`);
		const things = await browser.evaluate<string[]>(
			`[...document.querySelectorAll("[data-here-thing]")].map((e) => e.dataset.hereThing)`,
		);
		for (const thing of [...things, session]) {
			const at = thing === session ? `/w/${session}/settings` : `/w/${pi}/t/${thing}/settings`;
			await browser.open(`${origin}${at}`);
			if (thing === session) await press('[data-settings-tab="may"]');
			await browser.wait(`document.querySelector("[data-who-may] th")`);
			inWords(await shown(), at);
		}
		// Every registered kind by its title: the Make column's popup lists them all.
		await browser.open(`${origin}/w/${pi}/settings`);
		await press('[data-settings-tab="may"]');
		await press('[data-make="everyone"]');
		await browser.settled("[data-make-popup]");
		inWords(await shown(), "the Make popup");
		await browser.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
	});

	it("removes a session from Pi in its Settings view, also when it was addressed as a thing of Pi", async () => {
		const made = await (await owner.get(Workspace, { workspace: pi }, context)).make!(
			{ kind: "sessions.session", name: "To remove", input: {} },
			context,
		);
		// A session is a workspace placed in Pi, not a thing linked there: its thing address goes to its own (video2).
		// The chosen view goes along (Astra, follow-up): Back from its Settings shows that view.
		await browser.open(`${origin}/w/${pi}/t/${made}?view=transcript.session`);
		await browser.wait(`location.pathname === "/w/${made}" && location.search === "?view=transcript.session"`);
		await browser.open(`${origin}/w/${pi}/t/${made}/settings?view=transcript.session`);
		await browser.wait(
			`location.pathname === "/w/${made}/settings" && location.search === "?view=transcript.session"`,
		);
		await press("[data-unlink]");
		await press("[data-unlink-confirm]");
		await browser.wait(`location.pathname === "/w/${pi}"`);
		await browser.wait(`document.querySelector('[data-nav-workspace="${made}"]') === null`);
	});

	it("shows a person with Read only the session's transcript, with no way to send", async () => {
		// Ada is invited, put into Pi, and her Send on the session withheld: she keeps everyone's Read.
		const invited = await (await owner.get(People, {}, context)).invite({ name: "Ada" }, context);
		ada = invited.person;
		const { link } = invited;
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

	it("writes who may's access choice and Make column, and shows another page's write without a reload", async () => {
		await browser.size(DESKTOP);
		await browser.open(`${origin}/w/${pi}/t/${sketch}/settings`);
		const row = `person/${ada}`;
		const access = `document.querySelector('[data-access="${row}"]')?.textContent.trim()`;
		await browser.wait(`${access} === "(Can open)"`);
		// "Can open" and "No access" each write `@open` (test 6b); resetting deletes the row.
		for (const [choice, label] of [
			["open", "Can open"],
			["none", "No access"],
		] as const) {
			await press(`[data-access="${row}"]`);
			await browser.settled(`[data-access-choice="${choice}"]`);
			await press(`[data-access-choice="${choice}"]`);
			await browser.wait(`${access} === "${label}"`);
			await press(`[data-access="${row}"]`);
			await browser.settled('[data-access-choice="reset"]');
			await press('[data-access-choice="reset"]');
			await browser.wait(`${access} === "(Can open)"`);
		}
		// A write from another page (the owner's client) shows here at once (test 6).
		const workspace = await owner.get(Workspace, { workspace: pi }, context);
		const party = { kind: "person", person: ada } as const;
		await workspace.setTick!({ thing: sketch, party, tick: "draw", gives: false }, context);
		await eventually(
			() => look(row, "draw"),
			(found) => found === "withheld",
		);
		await workspace.setTick!({ thing: sketch, party, tick: "draw" }, context);
		await eventually(
			() => look(row, "draw"),
			(found) => found === "inherited",
		);
		// The Make column (test 6c): "All kinds" writes `@make:*`; two kinds write two rows, named in the summary.
		await browser.open(`${origin}/w/${pi}/settings`);
		await press('[data-settings-tab="may"]');
		const summary = `document.querySelector('[data-make="${row}"]')?.textContent.trim()`;
		await browser.wait(`${summary} === "nothing"`);
		await press(`[data-make="${row}"]`);
		await browser.settled("[data-make-popup]");
		const toggle = async (tick: string, to: string) => {
			await press(`[data-make-popup] [data-tick="${tick}"] [role="checkbox"]`);
			await browser.wait(
				`document.querySelector('[data-make-popup] [data-tick="${tick}"]')?.dataset.look === "${to}"`,
			);
		};
		await toggle("@make:*", "given");
		await browser.wait(`${summary} === "all kinds"`);
		await toggle("@make:*", "empty");
		await toggle("@make:canvas.board", "given");
		await toggle("@make:page-kinds.note", "given");
		await browser.wait(`${summary} === "Canvas, Note"`);
		await toggle("@make:canvas.board", "empty");
		await toggle("@make:page-kinds.note", "empty");
		await browser.wait(`${summary} === "nothing"`);
		await browser.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
	});

	it("on a phone, draws who may as one card per party, and a tick there writes its row", async () => {
		await browser.size(PHONE);
		await browser.open(`${origin}/w/${pi}/t/${sketch}/settings`);
		await browser.wait(
			`document.querySelector('[data-who-may-row="everyone"] [data-tick="draw"]')?.offsetParent != null`,
		);
		// One form is rendered, not both: no table on a phone (Fable S6).
		assert.equal(await browser.evaluate(`document.querySelector("[data-who-may] table") === null`), true);
		assert.equal(await look("everyone", "draw"), "given");
		await press('[data-who-may-row="everyone"] [data-tick="draw"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "draw"),
			(found) => found === "empty",
		);
		await shots("21-who-may-phone");
		await press('[data-who-may-row="everyone"] [data-tick="draw"] [role="checkbox"]');
		await eventually(
			() => look("everyone", "draw"),
			(found) => found === "given",
		);
		await browser.size(DESKTOP);
		await browser.wait(`document.querySelector("[data-who-may] table [data-who-may-row]")`);
		assert.equal(
			await browser.evaluate(`document.querySelector("[data-who-may] li[data-who-may-row]") === null`),
			true,
		);
	});

	it("switches the defaults for things and people from above in a workspace's Settings view", async () => {
		await browser.open(`${origin}/w/${family}/settings`);
		await press('[data-settings-tab="what"]');
		const things = `document.querySelector('[data-shows-from-above="things"]')?.getAttribute("aria-checked")`;
		await browser.wait(`${things} === "true"`);
		// Off: Sketch, which has no switch of its own here, is hidden too; Plans was already.
		await press('[data-shows-from-above="things"]');
		await browser.wait(`document.querySelector('[data-here-thing="${sketch}"]')?.dataset.hidden === "true"`);
		await press('[data-shows-from-above="things"]');
		await browser.wait(`document.querySelector('[data-here-thing="${sketch}"]')?.dataset.hidden === "false"`);
		await browser.wait(`document.querySelector("[data-nav-hidden]")?.textContent === "1 hidden"`);
		await press('[data-settings-tab="who"]');
		// Ada, put into Pi, is from above here (the owner made Family, so is put in here).
		const adaHidden = `document.querySelector('[data-here-party="person/${ada}"]')?.dataset.hidden`;
		await browser.wait(`${adaHidden} === "false"`);
		await press('[data-shows-from-above="people"]');
		await browser.wait(`${adaHidden} === "true"`);
		await press('[data-shows-from-above="people"]');
		await browser.wait(`${adaHidden} === "false"`);
	});

	it("offers a person without Link here nothing to link, only what they may make (test 7)", async () => {
		// The owner may link Pi's Sketch into Family.
		await browser.open(`${origin}/w/${family}/settings`);
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await browser.wait(`document.querySelector('[data-add-offer="link:${sketch}"]')`);
		await press('[data-add-thing-dialog] button[aria-label="Close"]');
		// Bea has Link in Pi (so Pi's things are linkable for her) and Make in Family, where her Link is withheld.
		const { person: bea, link } = await (await owner.get(People, {}, context)).invite({ name: "Bea" }, context);
		await t.host.root(async (ctx) => {
			const store = await ctx.get(ThingsStore, {});
			const party = { kind: "person", person: bea } as const;
			const source = { kind: "person", person: ownerId } as const;
			await store.putParty({ workspace: pi, party, source }, ctx);
			await store.setGrants(
				{
					source,
					grants: [
						{ workspace: pi, thing: pi, party, tick: "link", gives: true },
						{ workspace: family, thing: family, party, tick: "link", gives: false },
						{ workspace: family, thing: family, party, tick: "@make:*", gives: true },
					],
				},
				ctx,
			);
		}, context);
		await browser.signOut();
		await browser.open(`${origin}${link}`);
		await browser.wait(`document.querySelector("[data-person-menu]")?.textContent.includes("Bea")`);
		await browser.open(`${origin}/w/${family}/settings`);
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await browser.wait(`document.querySelector('[data-add-offer="make:canvas.board"]')`);
		assert.equal(await browser.evaluate(`document.querySelector('[data-add-offer^="link:"]') === null`), true);
		await browser.signOut();
		await browser.signIn(origin, await t.cookie(context));
	});

	it("shows a person present only below no name or id of the workspaces above (test 5a)", async () => {
		// Max is present only in Stuff, in Family: Stuff is his root, what reaches it from Family or Pi is "from above".
		const stuff = await (await owner.get(Workspace, { workspace: family }, context)).make!(
			{ kind: "things.workspace", name: "Stuff" },
			context,
		);
		const { person: max, link } = await (await owner.get(People, {}, context)).invite({ name: "Max" }, context);
		await t.host.root(async (ctx) => {
			const store = await ctx.get(ThingsStore, {});
			const source = { kind: "person", person: ownerId } as const;
			await store.putParty({ workspace: stuff, party: { kind: "person", person: max }, source }, ctx);
		}, context);
		await browser.signOut();
		await browser.open(`${origin}${link}`);
		await browser.wait(`document.querySelector("[data-person-menu]")?.textContent.includes("Max")`);
		await browser.open(`${origin}/`);
		await browser.wait(`location.pathname === "/w/${stuff}"`);
		await browser.wait(`document.querySelector('[data-nav-thing="${sketch}"]')?.textContent.includes("from above")`);
		await press('[data-settings-tab="what"]');
		await browser.wait(`document.querySelector('[data-here-thing="${sketch}"]')?.textContent.includes("from above")`);
		const page = await browser.evaluate<string>("document.body.innerHTML");
		for (const banned of ["Family", family, pi]) assert.ok(!page.includes(banned), `the page names ${banned}`);
		await browser.signOut();
		await browser.signIn(origin, await t.cookie(context));
	});

	it("opens links from the invite dialog: a new member and a new guest are signed in, a signed-in person is put in", async () => {
		/** A link into Family made in its invite dialog, `as` a member or a guest, for `name`. */
		const link = async (as: "member" | "guest", name: string) => {
			await browser.open(`${origin}/w/${family}/settings`);
			await press("[data-invite-open]");
			await browser.settled("[data-invite-dialog]");
			await press(`[data-invite-as="${as}"]`);
			await browser.type("[data-invite-name]", name);
			await press("[data-invite-create]");
			await browser.wait(`document.querySelector("[data-invite-url]")?.value.length > 0`);
			return browser.evaluate<string>(`document.querySelector("[data-invite-url]").value`);
		};
		const ownerCookie = await browser.cookie(origin);
		let gusCookie = "";
		for (const [as, name] of [
			["member", "Mia"],
			["guest", "Gus"],
		] as const) {
			const url = await link(as, name);
			await browser.signOut();
			await browser.open(url);
			await browser.wait(`document.querySelector("[data-person-menu]")?.textContent.includes("${name}")`);
			await browser.wait(`location.pathname.startsWith("/w/${family}")`);
			gusCookie = await browser.cookie(origin);
			await browser.signOut();
			await browser.signIn(origin, ownerCookie);
		}
		// Gus, signed in as the guest he is, opens a member link: he keeps his sign-in (no new person "Gus again") and is
		// put into Family as himself. (A person of the people plugin's own, as Ada, is not in the things store until
		// ERNDL-1144 push B: their link is refused.)
		const url = await link("member", "Gus again");
		await browser.signOut();
		await browser.signIn(origin, gusCookie);
		await browser.open(url);
		await browser.wait(
			`document.querySelector("[data-person-menu]")?.textContent.includes("Gus") && !document.querySelector("[data-person-menu]").textContent.includes("again")`,
		);
		await browser.signOut();
		await browser.signIn(origin, ownerCookie);
		await browser.open(`${origin}/w/${family}/settings`);
		await press('[data-settings-tab="who"]');
		await browser.wait(
			`[...document.querySelectorAll('[data-here-party^="person/"]')].some((e) => e.textContent.includes("Gus"))`,
		);
	});

	it("keeps the chosen view (?view=) through the gear and Back", async () => {
		const file = join(t.userRoot, "print.web.tsx");
		await writeFile(
			file,
			[
				'import { defineFacet } from "@earendil-works/p3/v1";',
				'import { Views } from "@earendil-works/p3/v1/web";',
				'function Print() { return <p data-print="">print</p>; }',
				"export default defineFacet((_host, self) =>",
				'	self.contribute(Views, [{ view: "print.board", title: { namespace: "print", key: "board", params: [] }, area: "main", for: { kind: "thing", thingKind: "canvas.board" }, View: Print }]),',
				");",
			].join("\n"),
		);
		await until(t.plugins, (state) => state.set, within("the new plugin seen", context, 10_000));
		await t.apply(context);
		await browser.size(PHONE);
		await browser.open(`${origin}/w/${pi}/t/${sketch}?view=print.board`);
		await browser.wait(`document.querySelector("[data-print]")`);
		await press("[data-gear]");
		await browser.wait(`location.pathname.endsWith("/settings") && location.search === "?view=print.board"`);
		await press("[data-back]");
		await browser.wait(`document.querySelector("[data-print]") && location.search === "?view=print.board"`);
		await browser.size(DESKTOP);
		await rm(file);
		await until(t.plugins, (state) => state.dirty.length > 0, within("the removal seen", context, 10_000));
		await t.apply(context);
	});

	it("brings a session's pane back when its thing is shown again, and keeps ?view= through pane focus", async () => {
		// A board made in Pi comes down into the session, as a pane; hidden there, its pane goes.
		const workspace = await owner.get(Workspace, { workspace: session }, context);
		await browser.open(`${origin}/w/${session}?view=transcript.session`);
		await browser.wait(`document.querySelector('[data-session-view="${session}"]')`);
		const board = await (await owner.get(Workspace, { workspace: pi }, context)).make!(
			{ kind: "canvas.board", name: "Pane board" },
			context,
		);
		await press(`[data-pane-tab="${board}"] [role="tab"]`);
		await browser.wait(
			`location.pathname === "/w/${session}/${board}" && location.search === "?view=transcript.session"`,
		);
		await workspace.hide!({ thing: board, shown: false }, context);
		await browser.wait(`document.querySelector('[data-pane-tab="${board}"]') === null`);
		await workspace.hide!({ thing: board, shown: true }, context);
		await browser.wait(`document.querySelector('[data-pane-tab="${board}"]')`);
	});

	it("keeps the add dialog's draft through an apply (the folder and the removals written as chosen), and drops it on close", async () => {
		await browser.size(DESKTOP);
		await browser.open(`${origin}/w/${pi}/settings`);
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await browser.settled("[data-add-thing-dialog]");
		await press('[data-add-offer="make:sessions.session"]');
		await browser.type("[data-add-name]", "Alpha");
		await browser.type('[data-field="folder"]', "/custom/folder");
		await press('[data-add-default="everyone/send"]');
		const draft = () =>
			browser.evaluate<string>(
				`JSON.stringify([document.querySelector("[data-add-name]").value, document.querySelector('[data-field="folder"]').value, document.querySelector('[data-add-default="everyone/send"]').getAttribute("aria-checked")])`,
			);
		const before = await draft();
		assert.equal(before, JSON.stringify(["Alpha", "/custom/folder", "false"]));
		// Astra, review round 2: an apply of the things plugin remounted the dialog and lost the folder and the removal.
		const file = join(builtIn, "things/add-thing.tsx");
		await writeFile(
			file,
			(await readFile(file, "utf8")).replace(
				'data-add-confirm-button=""',
				'data-add-confirm-button="" data-draft-apply=""',
			),
		);
		await until(t.plugins, (state) => state.dirty.length > 0, within("the edit seen", context, 10_000));
		await t.apply(context);
		await browser.wait(
			`document.querySelector("[data-draft-apply]") && document.querySelector("[data-new-session]")`,
		);
		assert.equal(await draft(), before);
		await press("[data-add-confirm-button]");
		await browser.wait(`document.querySelector("[data-add-thing-dialog]") === null`);
		const entry = `[...document.querySelectorAll("[data-nav-workspace]")].find((e) => e.textContent === "Alpha")`;
		await browser.wait(`${entry} !== undefined`);
		const alpha = await browser.evaluate<string>(`${entry}.dataset.navWorkspace`);
		await browser.open(`${origin}/w/${alpha}/settings`);
		await press('[data-settings-tab="may"]');
		await eventually(
			() => look("everyone", "read"),
			(found) => found === "given",
		);
		assert.equal(await look("everyone", "send"), "empty");
		// Closed, the draft is gone: the next dialog starts with no name.
		await browser.open(`${origin}/w/${pi}/settings`);
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await press('[data-add-offer="make:things.workspace"]');
		await browser.type("[data-add-name]", "Cancelled");
		await press('[data-add-thing-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-add-thing-dialog]") === null`);
		await press("[data-add-thing]");
		await press('[data-add-offer="make:canvas.board"]');
		assert.equal(await browser.evaluate(`document.querySelector("[data-add-name]").value`), "");
		await press('[data-add-thing-dialog] button[aria-label="Close"]');
	});

	it("makes one thing for two activations of Add before the page renders again", async () => {
		await browser.open(`${origin}/w/${pi}/settings`);
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await press('[data-add-offer="make:things.workspace"]');
		await browser.type("[data-add-name]", "Made once");
		await browser.evaluate(
			`(() => { const add = document.querySelector("[data-add-confirm-button]"); add.click(); add.click(); })()`,
		);
		await browser.wait(`document.querySelector("[data-add-thing-dialog]") === null`);
		const count = `[...document.querySelectorAll("[data-nav-workspace]")].filter((e) => e.textContent === "Made once").length`;
		await browser.wait(`${count} > 0`);
		// A second make would land within the idle second.
		await idles();
		assert.equal(await browser.evaluate(count), 1);
	});

	it("disables Add, saying why, when Make of the chosen kind is withdrawn while the dialog is open", async () => {
		const workspace = await owner.get(Workspace, { workspace: pi }, context);
		const { person, link } = await (await owner.get(People, {}, context)).invite({ name: "Maker" }, context);
		const party = { kind: "person", person } as const;
		// The Workspace's putParty takes only whom its picker offers: an invited person is put in by the store.
		await t.host.root(async (ctx) => {
			const store = await ctx.get(ThingsStore, {});
			await store.putParty({ workspace: pi, party, source: { kind: "person", person: ownerId } }, ctx);
		}, context);
		for (const kind of ["canvas.board", "things.workspace"]) {
			await workspace.setTick!({ thing: pi, party, tick: `@make:${kind}`, gives: true }, context);
		}
		await browser.signOut();
		await browser.open(`${origin}${link}`);
		await browser.wait(`document.querySelector("[data-person-menu]")?.textContent.includes("Maker")`);
		await browser.open(`${origin}/w/${pi}/settings`);
		await press('[data-settings-tab="what"]');
		await press("[data-add-thing]");
		await press('[data-add-offer="make:canvas.board"]');
		await browser.type("[data-add-name]", "Chosen before");
		await browser.wait(`document.querySelector("[data-add-confirm-button]")?.disabled === false`);
		await workspace.setTick!({ thing: pi, party, tick: "@make:canvas.board" }, context);
		await browser.wait(
			`document.querySelector("[data-add-not-allowed]") && document.querySelector("[data-add-confirm-button]").disabled`,
		);
		await browser.signOut();
		await browser.signIn(origin, await t.cookie(context));
	});

	it("writes a default unticked and ticked again in the add dialog (no removal)", async () => {
		await browser.open(`${origin}/w/${pi}/settings`);
		await add("make:page-kinds.note", "Ticked again", ["agents/write", "agents/write"]);
		const entry = `[...document.querySelectorAll('[data-nav-thing]')].find((e) => e.textContent === "Ticked again")`;
		await browser.wait(`${entry} !== undefined`);
		await browser.open(`${origin}/w/${pi}/t/${await browser.evaluate<string>(`${entry}.dataset.navThing`)}/settings`);
		await eventually(
			() => look("agents", "write"),
			(found) => found === "given",
		);
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
		await browser.wait(`document.querySelector("[data-gear]") === null`);
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

	it("keeps the open page, an unsent draft and the open Settings tab through an apply of chrome, things and transcript", async () => {
		const edit = async (path: string, from: string, to: string) => {
			const file = join(builtIn, ...path.split("/"));
			await writeFile(file, (await readFile(file, "utf8")).replace(from, to));
		};
		const apply = async () => {
			await until(t.plugins, (state) => state.dirty.length > 0, within("the edit seen", context, 10_000));
			await t.apply(context);
		};
		// An unsent draft in a session survives the transcript's and the chrome's apply (review round 1, must 4).
		await browser.open(`${origin}/w/${session}`);
		await browser.wait(`document.querySelector('[data-transcript="writer"]')`);
		await browser.evaluate("window.p3Marker = 1");
		await browser.type("[data-message]", "important draft");
		const at = await browser.evaluate<string>("location.pathname + location.search");
		await edit("transcript/messages.ts", 'send: "Send",', 'send: "Send!",');
		await edit("chrome/messages.ts", 'settings: "Settings",', 'settings: "Settings!",');
		await apply();
		await browser.wait(`document.querySelector("[data-send]")?.textContent.includes("Send!")`);
		await browser.wait(`document.querySelector("[data-message]")?.value === "important draft"`);
		assert.equal(await browser.evaluate("location.pathname + location.search"), at);
		// The Settings view's open tab survives the things plugin's apply.
		await browser.open(`${origin}/w/${pi}/settings`);
		await browser.evaluate("window.p3Marker = 1");
		await press('[data-settings-tab="what"]');
		await edit("things/page-messages.ts", 'whatIsHere: "What is here?",', 'whatIsHere: "What is here?!",');
		await apply();
		await browser.wait(`document.querySelector('[data-settings-tab="what"]')?.textContent.includes("?!")`);
		await browser.wait(`document.querySelector("[data-what-is-here]") !== null`);
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

	it("tries a view that threw again once an apply brings its fix, at the same address", async () => {
		// A person view that throws, then the same plugin fixed (Astra, review round 1).
		const file = join(t.userRoot, "broken.web.tsx");
		const source = (body: string) =>
			[
				'import { defineFacet } from "@earendil-works/p3/v1";',
				'import { Views } from "@earendil-works/p3/v1/web";',
				`function Person() { ${body} }`,
				"export default defineFacet((_host, self) =>",
				'	self.contribute(Views, [{ view: "broken.person", title: { namespace: "broken", key: "person", params: [] }, area: "main", for: { kind: "person" }, View: Person }]),',
				");",
			].join("\n");
		await rm(join(t.userRoot, "skew.web.tsx"));
		await writeFile(file, source('throw new Error("broken on purpose");'));
		await until(t.plugins, (state) => state.dirty.length > 0, within("the plugin seen", context, 10_000));
		await t.apply(context);
		await browser.open(`${origin}/w/${pi}/p/${ownerId}`);
		await browser.wait(`document.querySelector("[data-view-error]")?.textContent.includes("broken on purpose")`);
		const at = await browser.evaluate<string>("location.pathname");
		await writeFile(file, source('return <p data-fixed="">fixed</p>;'));
		await until(t.plugins, (state) => state.dirty.length > 0, within("the fix seen", context, 10_000));
		await t.apply(context);
		await browser.wait(`document.querySelector("[data-fixed]") !== null`);
		assert.equal(await browser.evaluate("location.pathname"), at);
		await rm(file);
		await until(t.plugins, (state) => state.dirty.length > 0, within("the removal seen", context, 10_000));
		await t.apply(context);
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
			browser.console.filter((line) => !line.includes(MISSING_COMPONENT) && !line.includes("broken on purpose")),
			[],
		);
	});
});
