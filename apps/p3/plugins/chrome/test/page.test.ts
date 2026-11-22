// The page in a real browser (only when asked: `P3_BROWSER_TESTS=1` with `CHROMIUM_BIN`), on p3's real server with a
// copy of the built-in plugins the test edits and the tests' faux login: the bar shows the app and the connection; a session made through
// the form appears in the list and opens in the transcript, which streams a scripted answer; a phone shows one screen
// at a time; a reload of the chrome plugin keeps the open page; an app without the bar gets a corner button, and an
// app that throws shows its error below the bar; a person invited from the person menu and added to the session
// enters Coding and works in it, brings their own notes (the owner sees them as theirs) and withdraws them, sees the
// session refused once removed from it, and no app once removed from every session of Coding. Screenshots of the steps at the phone's and the desktop's size go to `/tmp/p3-base/shots/`
// (`P3_SHOTS` names another directory).

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	type Host,
	type P3Principal,
	Sessions,
	thingOf,
	until,
} from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { FauxLogin } from "../../../test/plugins/faux-login/contract.ts";
import { within } from "../../../test/until.ts";
import { BROWSER_SKIP, Browser, DESKTOP, PHONE } from "./browser.ts";

/** The checkout's built-in plugins, which the test copies and edits. */
const BUILT_IN = fileURLToPath(new URL("../../", import.meta.url));

/** The tests' faux login: a kind of thing whose model answers from a script. */
const FAUX = fileURLToPath(new URL("../../../test/plugins/faux-login/", import.meta.url));

/** The tests' notes: a kind of thing with records per person, which members who write bring. */
const NOTES = fileURLToPath(new URL("../../../test/plugins/notes/", import.meta.url));

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

	before(async () => {
		await mkdir(SHOTS, { recursive: true });
		const dataDir = await mkdtemp(join(tmpdir(), "p3-page-"));
		builtIn = join(dataDir, "builtin");
		await cp(BUILT_IN, builtIn, { recursive: true, filter: (path) => basename(path) !== "test" });
		t = await testServer({ dataDir, builtIn, plugins: [FAUX, NOTES] }, context);
		owner = await t.client(context);
		origin = `http://127.0.0.1:${t.port}`;
		browser = await Browser.start();
		await browser.signIn(origin, await t.cookie(context));
	});

	after(async () => {
		await browser?.close();
		await t?.close(context);
	});

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
		const sessions = await owner.get(Sessions, {}, context);
		const script = [
			{ when: "hello", reply: [{ kind: "text" as const, text: "Hello from the faux model." }] },
			{ when: "which title", reply: [{ kind: "tool" as const, name: "faux_session", args: "{}" }] },
			// The tool's result names the session's title.
			{ when: "First steps", reply: [{ kind: "text" as const, text: "It is called First steps." }] },
		];
		await sessions.addThing(
			{ session, thing: thingOf(FauxLogin, { provider: "faux", script, tool: true }) },
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
		// The owner adds Ada to the session in its view.
		await browser.click("[data-things-open]");
		await browser.wait(
			`document.querySelector('[data-add-member] [data-field="person"]')?.textContent.includes("Ada")`,
		);
		await browser.click("[data-add-member] button:not([data-field])");
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

	it("lets a person who writes bring their own notes, which the owner sees as theirs, and withdraw them", async () => {
		// Ada brings her notes: a kind with records per person (`test/plugins/notes`), offered to her as hers.
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(
			`document.querySelector('[data-bring-own] [data-field="record"]')?.textContent.includes("My notes")`,
		);
		assert.equal(await browser.evaluate(`document.querySelector("[data-add-thing]") === null`), true);
		// She reads the kinds by their titles and herself as "You".
		await browser.wait(`document.querySelector('[data-thing="tools.coding"]')?.textContent.includes("Coding tools")`);
		await browser.wait(`document.querySelector('[data-member="${ada}"]')?.textContent.includes("You")`);
		await browser.click("[data-bring]");
		const hers = `[data-thing="notes.notes"][data-by="person:${ada}"]`;
		await browser.wait(`document.querySelector('${hers}')?.textContent.includes("Yours")`);
		await browser.wait(
			`document.querySelector("[data-bring-own]")?.textContent.includes("Everything of yours is here.")`,
		);
		await browser.screenshot(join(SHOTS, "13-bring-person-desktop.png"));
		// The owner, in a browser of their own, sees them as Ada's and brings their own notes too.
		const adaCookie = await browser.cookie(origin);
		await browser.signOut();
		await browser.signIn(origin, await t.cookie(context));
		await browser.size(PHONE);
		await browser.open(`${origin}/coding/${session}`);
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(`document.querySelector('${hers}')?.textContent.includes("Ada's")`);
		await browser.wait(
			`document.querySelector('[data-bring-own] [data-field="record"]')?.textContent.includes("The owner's notes")`,
		);
		await browser.click("[data-bring]");
		const owners = `[data-thing="notes.notes"][data-by="owner"]`;
		await browser.wait(`document.querySelector('${owners}')?.textContent.includes("Yours")`);
		await browser.screenshot(join(SHOTS, "14-bring-owner-phone.png"));
		// Ada sees the owner's notes as the owner's, without a way to withdraw them, and withdraws her own.
		await browser.signOut();
		await browser.signIn(origin, adaCookie);
		await browser.size(DESKTOP);
		await browser.open(`${origin}/coding/${session}`);
		await browser.click("[data-things-open]");
		await browser.settled("[data-things-dialog]");
		await browser.wait(`document.querySelector('${owners}')?.textContent.includes("The owner's")`);
		assert.equal(await browser.evaluate(`document.querySelector('${owners} button') === null`), true);
		await browser.click(`${hers} button`);
		await browser.wait(`document.querySelector('${hers}') === null`);
		await browser.wait(
			`document.querySelector('[data-bring-own] [data-field="record"]')?.textContent.includes("My notes")`,
		);
		await browser.screenshot(join(SHOTS, "15-withdrawn-desktop.png"));
		await browser.click('[data-things-dialog] button[aria-label="Close"]');
		await browser.wait(`document.querySelector("[data-session-things]") === null`);
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

	it("leaves nothing reported on the server, and no error in the page but the broken app's", () => {
		assert.deepEqual(t.errors, []);
		assert.deepEqual(
			browser.console.filter((line) => !line.includes("the page broke")),
			[],
		);
	});
});

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
