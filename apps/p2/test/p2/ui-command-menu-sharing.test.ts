// Browser: the sharing and artifact commands of the command menu (Cmd+K) at 1280×800. Sharing (owner, session
// target): Share session… opens the share sheet over the open session in one step, over a hovered session after opening
// it (Back closes the sheet, then returns); Copy read-only and Copy read/write link make the link and copy it; Reset
// share link… (only while a link exists) replaces one; none of them for an archived session or a guest. Artifacts:
// Open artifact… (only while the open conversation has some) lists every version and opens one in the viewer, also
// over a hovered session's main conversation; the root's query finds the latest version by title. Fake provider;
// disposable data, every test makes its own sessions.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ArtifactList } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** What the open menu shows, or null while it is closed. */
type MenuState = {
	chip: string | null;
	crumbs: string[];
	/** The groups on screen (a group without rows is hidden by CSS), each with its rows' titles and suffixes. */
	groups: [string, [string, string][]][];
};

const MENU = `(() => {
	const menu = document.querySelector('.command-menu');
	if (!menu) return null;
	return {
		chip: menu.querySelector('.command-chip')?.textContent ?? null,
		crumbs: [...menu.querySelectorAll('.command-crumb')].map((e) => e.textContent),
		groups: [...menu.querySelectorAll('.command-group')].filter((g) => getComputedStyle(g).display !== 'none').map((g) => [g.querySelector('.command-heading').textContent, [...g.querySelectorAll('[role=option]')].map((o) => [o.querySelector('.command-title').textContent, o.querySelector('.command-suffix-text')?.textContent ?? ''])]),
	};
})()`;

const OPEN = `Boolean(document.querySelector('.command-menu'))`;
const CLOSED = `!document.querySelector('.command-menu')`;
const TITLES = `[...document.querySelectorAll('.command-menu [role=option] .command-title')].map((e) => e.textContent)`;
const SELECTED = `document.querySelector('.command-menu [role=option][aria-selected=true] .command-title')?.textContent`;
const COUNTED = `(() => { const n = document.querySelectorAll('.command-menu [role=option]').length; return document.querySelector('.command-menu .command-count')?.textContent === (n === 1 ? '1 result' : n + ' results'); })()`;
const RECENTS = "p2-command-recents-v1";
/** Whether the share sheet is open, as an expression. */
const SHARE_SHEET = `[...document.querySelectorAll('.sheet h2')].some((e) => e.textContent === 'Share')`;
/** The text the page copied last (the clipboard is stubbed: headless Chromium has none to read back). */
const COPIED = "window.copiedText";
const STUB_CLIPBOARD = `navigator.clipboard.writeText = async (text) => { window.copiedText = text; }`;

const KEYS: Record<string, { code: string; keyCode: number }> = {
	Enter: { code: "Enter", keyCode: 13 },
	Escape: { code: "Escape", keyCode: 27 },
};

describe("command menu: sharing and artifacts", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let userAgent: string;
	let base: string;

	before(async () => {
		fixture = await startFixture({ web: true });
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		userAgent = ((await browser.call("Browser.getVersion")) as { userAgent: string }).userAgent;
		base = `http://127.0.0.1:${fixture.server.port}`;
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	const create = async (title: string) =>
		(await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;

	/** Saves the fake provider's `artifact` call (name "demo", "Demo artifact") `versions` times in `session`. */
	const makeArtifacts = async (session: string, versions: number) => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const list = owner.hold(ArtifactList, { session, conversation: 1 }, BACKGROUND_CONTEXT);
		try {
			for (let version = 1; version <= versions; version++) {
				await chat.send({ text: "artifact", requestId: `artifact-${session}-${version}` }, BACKGROUND_CONTEXT);
				await until(list.artifacts, (value) => value?.length === version, 30_000);
			}
		} finally {
			chat.release();
			list.release();
		}
	};

	/** Opens `path` at 1280×800 as a macOS page and waits for the composer while online. */
	const load = async (path: string, ready = ".composer textarea", page = browser) => {
		await page.metrics(1280, 800);
		await page.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
		await page.open(`${base}${path}`);
		await page.evaluate(`localStorage.removeItem(${JSON.stringify(RECENTS)})`);
		await page.wait(`document.querySelector(${JSON.stringify(ready)}) && !document.querySelector('.offline')`);
	};

	const openSession = async (id: string, title: string) => {
		await load(`/s/${id}`);
		await browser.wait(`document.querySelector('.topbar h1')?.textContent===${JSON.stringify(title)}`);
	};

	const press = async (key: string, modifiers: { meta?: boolean } = {}, page = browser) => {
		const known = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
		const event = { key, code: known.code, windowsVirtualKeyCode: known.keyCode, modifiers: modifiers.meta ? 4 : 0 };
		await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
		await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
	};

	const type = (text: string) => browser.call("Input.insertText", { text });
	const menu = () => browser.evaluate<MenuState | null>(MENU);

	/** Opens the menu and waits for its input to have focus and its rows to settle. */
	const openMenu = async (page = browser) => {
		await press("k", { meta: true }, page);
		await page.wait(`${OPEN} && document.activeElement?.matches('.command-menu input')`);
		await page.wait(COUNTED);
	};

	/** Types `query` into the open menu, waits until the highlighted row is `title`, then presses Enter. */
	const run = async (query: string, title: string) => {
		await type(query);
		await browser
			.wait(`${SELECTED}===${JSON.stringify(title)}`)
			.catch(async () => assert.fail(`"${title}" not highlighted: ${JSON.stringify(await menu())}`));
		await press("Enter");
	};

	/** Waits until the open menu lists `title` (rows behind a `Shown` wrapper appear once their state arrived). */
	const listed = (title: string) => browser.wait(`${TITLES}.includes(${JSON.stringify(title)})`);

	const titles = () => browser.evaluate<string[]>(TITLES);

	/** Moves the mouse to the middle of the element `expression` evaluates to, once there is one. */
	const hover = async (expression: string) => {
		await browser.wait(expression);
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	};

	/** A session's main row in the sidebar's Recents, as an expression. */
	const sidebarRow = (id: string) =>
		`document.querySelector('.sidebar-section[data-key=recent] .nav-row:has(> a.session-main[href="/s/${id}"])')`;

	/** The path, whether the share sheet shows, and the viewer's title. */
	const where = () =>
		browser.evaluate<{ path: string; sheet: boolean; viewer: string | null }>(
			`({ path: location.pathname, sheet: ${SHARE_SHEET}, viewer: document.querySelector('.viewer-panel')?.getAttribute('aria-label') ?? null })`,
		);

	const back = () => browser.evaluate("history.back()");

	describe("sharing", () => {
		it("opens the open session's share sheet in one step: Back closes it", async () => {
			const id = await create("Share open");
			await openSession(id, "Share open");
			await openMenu();
			await listed("Share session…");
			await run("share", "Share session…");
			await browser.wait(`${CLOSED} && ${SHARE_SHEET}`);
			assert.equal((await where()).path, `/s/${id}`);
			await back();
			await browser.wait(`!${SHARE_SHEET}`);
			assert.equal((await where()).path, `/s/${id}`);
		});

		it("opens a hovered session's share sheet over it: Back closes the sheet, then returns", async () => {
			const open = await create("Share from here");
			const hovered = await create("Share that one");
			await openSession(open, "Share from here");
			await hover(sidebarRow(hovered));
			await openMenu();
			assert.equal((await menu())?.chip, "Session · Share that one");
			await listed("Share session…");
			await run("share", "Share session…");
			await browser.wait(`${CLOSED} && ${SHARE_SHEET} && location.pathname === '/s/${hovered}'`);
			await browser.wait(`document.querySelector('.topbar h1')?.textContent === 'Share that one'`);
			await back();
			await browser.wait(`!${SHARE_SHEET}`);
			assert.equal((await where()).path, `/s/${hovered}`);
			await back();
			await browser.wait(`location.pathname === '/s/${open}'`);
			assert.equal((await where()).sheet, false);
		});

		it("copies the read-only and the read/write link, making them first", async () => {
			const id = await create("Copy links");
			const sharing = await holdIn(owner, Sharing, { session: id }, "owner");
			try {
				await openSession(id, "Copy links");
				await browser.evaluate(STUB_CLIPBOARD);
				for (const [query, title, mode] of [
					["copy read-only", "Copy read-only link", "view"],
					["copy read/write", "Copy read/write link", "full"],
				] as const) {
					await openMenu();
					await listed(title);
					await run(query, title);
					await browser.wait(`${CLOSED} && typeof ${COPIED} === 'string'`);
					const links = await until(sharing.links, (value) => Boolean(value?.some((link) => link.mode === mode)));
					assert.equal(
						await browser.evaluate(COPIED),
						links?.find((link) => link.mode === mode)?.url,
						`${title} copies the ${mode} link`,
					);
					await browser.evaluate(`delete ${COPIED}`);
				}
				// Copying again copies the same link: no new one.
				const before = sharing.links.value.find((link) => link.mode === "view")?.url;
				await openMenu();
				await run("copy read-only", "Copy read-only link");
				await browser.wait(`typeof ${COPIED} === 'string'`);
				assert.equal(await browser.evaluate(COPIED), before);
			} finally {
				sharing.release();
			}
		});

		it("resets a link from its page, offered only while the session has one", async () => {
			const id = await create("Reset link");
			const sharing = await holdIn(owner, Sharing, { session: id }, "owner");
			try {
				await openSession(id, "Reset link");
				await openMenu();
				// Copy read/write link shows once the session's links arrived (none yet): no Reset then.
				await listed("Copy read/write link");
				assert.ok(!(await titles()).includes("Reset share link…"), String(await titles()));
				await press("Escape");
				await browser.wait(CLOSED);
				await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
				const token = sharing.links.value[0]?.token;
				await openMenu();
				await listed("Reset share link…");
				await run("reset", "Reset share link…");
				await browser.wait(`document.querySelector('.command-menu .command-crumb')?.textContent === 'Reset link'`);
				await listed("Reset read-only link");
				const page = await menu();
				assert.deepEqual(page?.groups, [["Share links", [["Reset read-only link", "Its guests lose access"]]]]);
				await press("Enter");
				await browser.wait(CLOSED);
				await until(sharing.links, (value) => value?.length === 1 && value[0]?.token !== token);
			} finally {
				sharing.release();
			}
		});

		it("offers no sharing for an archived session", async () => {
			const id = await create("Archived share");
			await sessions.archive({ id }, BACKGROUND_CONTEXT);
			await load("/list/archive", ".list-page .session-row");
			const row = `[...document.querySelectorAll('.list-page .session-row')].find((e) => e.querySelector('.session-title')?.textContent === 'Archived share')`;
			await browser.wait(row);
			await hover(row);
			await openMenu();
			assert.equal((await menu())?.chip, "Session · Archived share");
			await listed("Restore session");
			const shown = await titles();
			for (const title of [
				"Share session…",
				"Copy read-only link",
				"Copy read/write link",
				"Reset share link…",
				"Open artifact…",
			])
				assert.ok(!shown.includes(title), `${title} for an archived session: ${shown}`);
			await press("Escape");
			await browser.wait(CLOSED);
		});
	});

	describe("artifacts", () => {
		it("lists the open conversation's artifacts, every version, and opens one in the viewer in one step", async () => {
			const id = await create("With artifacts");
			await makeArtifacts(id, 2);
			await openSession(id, "With artifacts");
			await openMenu();
			await listed("Open artifact…");
			await run("open artifact", "Open artifact…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')?.textContent === 'Artifacts'`);
			await listed("Demo artifact");
			assert.deepEqual((await menu())?.groups, [
				[
					"Artifacts",
					[
						["Demo artifact", "html · v2"],
						["Demo artifact", "html · v1"],
					],
				],
			]);
			await press("Enter");
			await browser.wait(`${CLOSED} && document.querySelector('.viewer-panel')`);
			assert.deepEqual(await where(), { path: `/s/${id}`, sheet: false, viewer: "Demo artifact" });
			assert.match(
				await browser.evaluate<string>(`document.querySelector('.viewer-panel').textContent`),
				/version 2/,
			);
			await back();
			await browser.wait(`!document.querySelector('.viewer-panel')`);
			assert.equal((await where()).path, `/s/${id}`);
		});

		it("offers Open artifact… only while the open conversation has artifacts", async () => {
			const id = await create("First artifact");
			await openSession(id, "First artifact");
			await openMenu();
			await listed("Rename session…");
			assert.ok(!(await titles()).includes("Open artifact…"), String(await titles()));
			await press("Escape");
			await browser.wait(CLOSED);
			// The agent makes one while the page is open: the top bar's button shows it, and so does the menu.
			await makeArtifacts(id, 1);
			await browser.wait(`document.querySelector('.artifact-button')`);
			await openMenu();
			await listed("Open artifact…");
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it("finds the latest version of an artifact at the root by its title", async () => {
			const id = await create("Artifact search");
			await makeArtifacts(id, 2);
			await openSession(id, "Artifact search");
			await browser.wait(`document.querySelector('.artifact-button')`);
			await openMenu();
			await type("demo art");
			await browser.wait(
				`[...document.querySelectorAll('.command-menu .command-group')].some((g) => g.querySelector('.command-heading').textContent === 'Artifacts' && g.querySelector('[role=option] .command-suffix-text')?.textContent === 'html · v2')`,
			);
			const artifacts = (await menu())?.groups.find(([heading]) => heading === "Artifacts");
			// The latest version only, beside the command whose group it joins.
			assert.deepEqual(
				artifacts?.[1].filter(([title]) => title === "Demo artifact"),
				[["Demo artifact", "html · v2"]],
			);
			await browser.evaluate(
				`[...document.querySelectorAll('.command-menu [role=option]')].find((o) => o.querySelector('.command-suffix-text')?.textContent === 'html · v2').click()`,
			);
			await browser.wait(`${CLOSED} && document.querySelector('.viewer-panel')`);
			assert.match(
				await browser.evaluate<string>(`document.querySelector('.viewer-panel').textContent`),
				/version 2/,
			);
		});

		it("opens a hovered session's artifact over its main conversation: Back closes the viewer, then returns", async () => {
			const open = await create("Artifact from here");
			const hovered = await create("Artifact over there");
			await makeArtifacts(hovered, 1);
			await openSession(open, "Artifact from here");
			await hover(sidebarRow(hovered));
			await openMenu();
			assert.equal((await menu())?.chip, "Session · Artifact over there");
			await listed("Open artifact…");
			await run("open artifact", "Open artifact…");
			await listed("Demo artifact");
			await press("Enter");
			await browser.wait(
				`${CLOSED} && document.querySelector('.viewer-panel') && location.pathname === '/s/${hovered}'`,
			);
			await back();
			await browser.wait(`!document.querySelector('.viewer-panel')`);
			assert.equal((await where()).path, `/s/${hovered}`);
			await back();
			await browser.wait(`location.pathname === '/s/${open}'`);
		});
	});

	it("shows a guest the artifacts, no sharing", async () => {
		const id = await create("Guest artifacts");
		await makeArtifacts(id, 1);
		const sharing = owner.hold(Sharing, { session: id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => value?.length === 1);
		const guest = await Browser.start();
		try {
			await guest.metrics(1280, 800);
			await guest.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
			// A fresh profile on loopback gets the join form and joins as a guest (loopback-join.test.ts).
			await guest.open(`${base}${new URL(links![0]!.url).pathname}`);
			await guest.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
			await guest.evaluate(
				`(() => { const input = document.querySelector('#name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Reader'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
			);
			await guest.click("#join button");
			await guest.wait(`document.querySelector('.subagent-bar')?.textContent.includes('Joined as Reader')`);
			await guest.wait(`document.querySelector('.artifact-button')`);
			await openMenu(guest);
			await guest.wait(`${TITLES}.includes('Open artifact…')`);
			const shown = await guest.evaluate<string[]>(TITLES);
			for (const title of ["Share session…", "Copy read-only link", "Copy read/write link", "Reset share link…"])
				assert.ok(!shown.includes(title), `guest sees ${title}: ${shown}`);
		} finally {
			await guest.close();
			sharing.release();
		}
	});
});
