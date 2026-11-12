// Browser: the command menu's app commands at 1280×800 (macOS keys): Show sidebar and Hide sidebar, Close side panel,
// Change theme…, Open settings… with its page and the root's settings search, and the views' commands (Show view…,
// Hide view…, Add changes view, Add Markdown view…, Open saved view…, Annotate, Stop annotating), for the owner and a
// guest. Fake provider; disposable data, every test makes its own sessions.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { SavedViews, Views } from "../../plugins/views/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const OPEN = `Boolean(document.querySelector('.command-menu'))`;
const CLOSED = `!document.querySelector('.command-menu')`;
const TITLES = `[...document.querySelectorAll('.command-menu [role=option] .command-title')].map((e) => e.textContent)`;
const SELECTED = `document.querySelector('.command-menu [role=option][aria-selected=true] .command-title')?.textContent`;
const CHECKED = `[...document.querySelectorAll('.command-menu [role=option][aria-checked=true] .command-title')].map((e) => e.textContent)`;
const CRUMBS = `[...document.querySelectorAll('.command-menu .command-crumb')].map((e) => e.textContent)`;
const COUNTED = `(() => { const n = document.querySelectorAll('.command-menu [role=option]').length; return document.querySelector('.command-menu .command-count')?.textContent === (n === 1 ? '1 result' : n + ' results'); })()`;
/** The open menu's groups on screen with their rows' titles. */
const GROUPS = `[...document.querySelectorAll('.command-menu .command-group')].filter((g) => getComputedStyle(g).display !== 'none').map((g) => [g.querySelector('.command-heading').textContent, [...g.querySelectorAll('[role=option] .command-title')].map((e) => e.textContent)])`;
const RECENTS = "p2-command-recents-v1";
/** Whether the view titled `title` is the shown tab of its area. */
const front = (title: string) =>
	`[...document.querySelectorAll('.views-tab.on')].some((e) => e.textContent === ${JSON.stringify(title)})`;

const KEYS: Record<string, { code: string; keyCode: number }> = {
	Enter: { code: "Enter", keyCode: 13 },
	Escape: { code: "Escape", keyCode: 27 },
};

const viewResults = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "view",
		),
	);

describe("command menu: app and views commands", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let userAgent: string;
	let base: string;

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "notes.md"), "# Notes\n\nA line.\n");
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

	/** Opens a session's page at 1280×800 as macOS, without recents, a theme or a collapsed sidebar kept from before. */
	const openSession = async (id: string, title: string) => {
		await browser.metrics(1280, 800);
		await browser.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
		await browser.open(`${base}/s/${id}`);
		await browser.evaluate(
			`(() => { for (const key of [${JSON.stringify(RECENTS)}, 'pi-theme', 'pi-sidebar-collapsed']) localStorage.removeItem(key); })()`,
		);
		await browser.open(`${base}/s/${id}`);
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
		await browser.wait(`document.querySelector('.topbar h1')?.textContent===${JSON.stringify(title)}`);
	};

	const press = async (key: string, modifiers: { meta?: boolean } = {}) => {
		const known = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
		const event = { key, code: known.code, windowsVirtualKeyCode: known.keyCode, modifiers: modifiers.meta ? 4 : 0 };
		await browser.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
		await browser.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
	};

	const type = (text: string) => browser.call("Input.insertText", { text });

	/** Opens the menu (Cmd+K) and waits for its input's focus and its rows to settle. */
	const openMenu = async () => {
		await press("k", { meta: true });
		await browser.wait(`${OPEN} && document.activeElement?.matches('.command-menu input')`);
		await browser.wait(COUNTED);
	};

	/** Types `query`, waits until `title` is highlighted, then presses Enter. */
	const run = async (query: string, title: string) => {
		await type(query);
		await browser
			.wait(`${SELECTED}===${JSON.stringify(title)}`)
			.catch(async () =>
				assert.fail(`"${title}" not highlighted: ${JSON.stringify(await browser.evaluate(GROUPS))}`),
			);
		await press("Enter");
	};

	const closeMenu = async () => {
		await press("Escape");
		await browser.wait(CLOSED);
	};

	describe("layout", () => {
		it("hides the docked sidebar and shows it again, offering only the one that applies", async () => {
			const id = await create("Sidebar");
			await openSession(id, "Sidebar");
			await openMenu();
			await browser.wait(`${TITLES}.includes('Hide sidebar')`);
			assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Show sidebar"));
			await run("hide side", "Hide sidebar");
			await browser.wait(`${CLOSED} && document.querySelector('.app.sidebar-collapsed')`);
			await openMenu();
			await browser.wait(`${TITLES}.includes('Show sidebar')`);
			assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Hide sidebar"));
			await run("show side", "Show sidebar");
			await browser.wait(`${CLOSED} && !document.querySelector('.app.sidebar-collapsed')`);
			assert.equal(await browser.evaluate(`localStorage.getItem('pi-sidebar-collapsed')`), "0");
		});

		it("closes the side panel while it shows a run's activity", async () => {
			const id = await create("Side panel");
			await openSession(id, "Side panel");
			await openMenu();
			assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Close side panel"));
			await closeMenu();
			const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
			await chat.send({ text: "tool", requestId: "menu-tool" }, BACKGROUND_CONTEXT);
			chat.release();
			await browser.click("[data-testid=activity]");
			await browser.wait(`document.querySelector('#side-dock .activity-panel')`);
			await openMenu();
			await run("close side", "Close side panel");
			await browser.wait(`${CLOSED} && !document.querySelector('#side-dock .side-panel')`);
			await openMenu();
			assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Close side panel"));
			await closeMenu();
		});
	});

	describe("settings", () => {
		it("switches the theme from its page, the current one checked", async () => {
			const id = await create("Theme");
			await openSession(id, "Theme");
			await openMenu();
			// The theme's own words find it at the root.
			await run("dark mode", "Change theme…");
			await browser.wait(`${CRUMBS}[0]==='Theme'`);
			assert.deepEqual(await browser.evaluate(TITLES), ["System", "Light", "Dark"]);
			assert.deepEqual(await browser.evaluate(CHECKED), ["System"]);
			await run("dark", "Dark");
			await browser.wait(`${CLOSED} && document.documentElement.dataset.theme==='dark'`);
			assert.equal(await browser.evaluate(`localStorage.getItem('pi-theme')`), "dark");
			assert.equal(
				await browser.evaluate(`document.querySelector('.theme-toggle').getAttribute('title')`),
				"Theme: Dark",
			);
			await openMenu();
			await run("theme", "Change theme…");
			await browser.wait(`${CHECKED}[0]==='Dark'`);
			await run("light", "Light");
			await browser.wait(`${CLOSED} && document.documentElement.dataset.theme==='light'`);
		});

		it("lists the Settings window's sections in its order and opens one; Back closes the window", async () => {
			const id = await create("Settings page");
			await openSession(id, "Settings page");
			await openMenu();
			await run("open settings", "Open settings…");
			await browser.wait(`${CRUMBS}[0]==='Settings'`);
			const window = await browser.evaluate<string[]>(TITLES);
			assert.deepEqual(window.slice(0, 6), ["General", "Models", "Agent", "Requests", "Compaction", "Providers"]);
			for (const label of ["MCP servers", "Environments", "Devices", "Logs"])
				assert.ok(window.includes(label), label);
			assert.ok(window.indexOf("Environments") < window.indexOf("Devices"), String(window));
			await run("mcp", "MCP servers");
			await browser.wait(
				`${CLOSED} && document.querySelector('.settings-nav-item[aria-current=page]')?.textContent==='MCP servers'`,
			);
			await browser.evaluate("history.back()");
			await browser.wait(`!document.querySelector('.settings-window') && location.pathname==='/s/${id}'`);
		});

		it("finds a section typed at the root, by its name or its tooltip", async () => {
			const id = await create("Settings search");
			await openSession(id, "Settings search");
			await openMenu();
			await run("compaction", "Compaction");
			await browser.wait(
				`${CLOSED} && document.querySelector('.settings-nav-item[aria-current=page]')?.textContent==='Compaction'`,
			);
			await browser.wait(
				`document.querySelector('.settings-pane')?.textContent.includes('Compact long conversations')`,
			);
			await browser.evaluate("history.back()");
			await browser.wait(`!document.querySelector('.settings-window')`);
			// "remote" is in the Environments entry's tooltip ("Remote environments"); the rows join the Settings group.
			await openMenu();
			await type("remote");
			await browser.wait(`${SELECTED}==='Environments'`);
			const groups = await browser.evaluate<[string, string[]][]>(GROUPS);
			assert.ok(
				groups.some(([heading, titles]) => heading === "Settings" && titles.includes("Environments")),
				JSON.stringify(groups),
			);
			await press("Enter");
			await browser.wait(
				`${CLOSED} && document.querySelector('.settings-nav-item[aria-current=page]')?.textContent==='Environments'`,
			);
			await browser.evaluate("history.back()");
			await browser.wait(`!document.querySelector('.settings-window')`);
		});
	});

	describe("views", () => {
		it("hides a view on this device and shows it again", async () => {
			const id = await create("Views layout");
			const views = await holdIn(owner, Views, { session: id }, "editor");
			await views.open({ kind: "changes" }, BACKGROUND_CONTEXT);
			await openSession(id, "Views layout");
			const tab = `[...document.querySelectorAll('.views-tab')].some((e) => e.textContent === 'Changes')`;
			await browser.wait(tab);
			await openMenu();
			await run("hide view", "Hide view…");
			await browser.wait(`${CRUMBS}[0]==='Hide view' && ${TITLES}.length > 0`);
			assert.deepEqual(await browser.evaluate(TITLES), ["Changes"]);
			await press("Enter");
			await browser.wait(`${CLOSED} && !${tab}`);
			// Hidden here: Hide view… has nothing to hide; Show view… says it is hidden and brings it back.
			await openMenu();
			await browser.wait(`${TITLES}.includes('Show view…')`);
			assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Hide view…"));
			await run("show view", "Show view…");
			await browser.wait(`${TITLES}[0]==='Changes'`);
			assert.equal(
				await browser.evaluate(
					`document.querySelector('.command-menu [role=option] .command-suffix-text').textContent`,
				),
				"Changes · Hidden",
			);
			await press("Enter");
			await browser.wait(`${CLOSED} && ${tab}`);
			views.release();
		});

		it("adds a changes view and a Markdown view", async () => {
			const id = await create("Views add");
			const views = await holdIn(owner, Views, { session: id }, "editor");
			await openSession(id, "Views add");
			await openMenu();
			// Without views: nothing to show or hide.
			await browser.wait(`${TITLES}.includes('Add changes view')`);
			const titles = await browser.evaluate<string[]>(TITLES);
			assert.ok(!titles.includes("Show view…") && !titles.includes("Hide view…"), String(titles));
			await run("add changes", "Add changes view");
			await browser.wait(
				`${CLOSED} && [...document.querySelectorAll('.views-tab')].some((e) => e.textContent === 'Changes')`,
			);
			await openMenu();
			await run("markdown", "Add Markdown view…");
			await browser.wait(
				`document.querySelector('.command-menu .empty-note')?.textContent==="Type the file's path in the workspace"`,
			);
			await run("./notes.md", "Open “notes.md”");
			await until(views.views, (list) => list.some((view) => view.kind === "markdown" && view.path === "notes.md"));
			await browser.wait(`${CLOSED} && ${front("notes.md")}`);
			views.release();
		});

		it("opens a view saved in the owner's library", async () => {
			const id = await create("Views saved");
			const views = await holdIn(owner, Views, { session: id }, "editor");
			const { id: view } = await views.open({ kind: "changes", title: "Saved changes" }, BACKGROUND_CONTEXT);
			const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
			await chat.send(
				{
					text: `view ${JSON.stringify({ action: "save", id: view, name: "menu-saved" })}`,
					requestId: "menu-save",
				},
				BACKGROUND_CONTEXT,
			);
			await until(chat.view, (value) => viewResults(value).length === 1);
			chat.release();
			const library = await holdIn(owner, SavedViews, {}, "owner");
			await until(library.saved, (saved) => saved.some((each) => each.name === "menu-saved"));
			await views.close({ id: view }, BACKGROUND_CONTEXT);
			await openSession(id, "Views saved");
			await openMenu();
			await run("saved view", "Open saved view…");
			await browser.wait(`${TITLES}.includes('Saved changes')`);
			await run("saved changes", "Saved changes");
			await until(views.views, (list) => list.some((each) => each.title === "Saved changes"));
			await browser.wait(`${CLOSED} && ${front("Saved changes")}`);
			await library.remove({ name: "menu-saved" }, BACKGROUND_CONTEXT);
			views.release();
		});

		it("switches annotation mode on and off", async () => {
			const id = await create("Annotate");
			await openSession(id, "Annotate");
			await openMenu();
			await browser.wait(`${TITLES}.includes('Annotate')`);
			assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Stop annotating"));
			await run("annotate", "Annotate");
			await browser.wait(`${CLOSED} && document.querySelector('.views-annotate-toggle[aria-pressed=true]')`);
			await openMenu();
			await run("stop annot", "Stop annotating");
			await browser.wait(`${CLOSED} && document.querySelector('.views-annotate-toggle[aria-pressed=false]')`);
		});

		it("leaves out the views commands for another session than the open one", async () => {
			const open = await create("Open with views");
			const other = await create("Other row");
			await openSession(open, "Open with views");
			const row = `.sidebar-section[data-key=recent] .nav-row:has(> a.session-main[href="/s/${other}"])`;
			await browser.wait(`document.querySelector(${JSON.stringify(row)})`);
			const point = await browser.evaluate<{ x: number; y: number }>(
				`(() => { const r = document.querySelector(${JSON.stringify(row)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
			);
			await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
			await openMenu();
			assert.equal(
				await browser.evaluate(`document.querySelector('.command-menu .command-chip')?.textContent`),
				"Session · Other row",
			);
			await browser.wait(`${TITLES}.includes('Rename session…')`);
			const titles = await browser.evaluate<string[]>(TITLES);
			for (const title of ["Annotate", "Add changes view", "Add Markdown view…", "Open saved view…"])
				assert.ok(!titles.includes(title), `${title}: ${titles}`);
			await closeMenu();
			await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 });
		});
	});

	it("shows a guest the theme and the views it may see, not the owner's settings or edits", async () => {
		const id = await create("Guest views");
		const views = await holdIn(owner, Views, { session: id }, "editor");
		await views.open({ kind: "changes" }, BACKGROUND_CONTEXT);
		const sharing = owner.hold(Sharing, { session: id }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => value?.length === 1);
		const guest = await Browser.start();
		try {
			await guest.metrics(1280, 800);
			await guest.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
			await guest.open(`${base}${new URL(links![0]!.url).pathname}`);
			await guest.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
			await guest.evaluate(
				`(() => { const input = document.querySelector('#name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Reader'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
			);
			await guest.click("#join button");
			await guest.wait(`document.querySelector('.subagent-bar')?.textContent.includes('Joined as Reader')`);
			await guest.wait(`[...document.querySelectorAll('.views-tab')].some((e) => e.textContent === 'Changes')`);
			for (const kind of ["rawKeyDown", "keyUp"])
				await guest.call("Input.dispatchKeyEvent", {
					type: kind,
					key: "k",
					code: "KeyK",
					windowsVirtualKeyCode: 75,
					modifiers: 4,
				});
			await guest.wait(OPEN);
			await guest.wait(`${TITLES}.includes('Change theme…') && ${TITLES}.includes('Show view…')`);
			const titles = await guest.evaluate<string[]>(TITLES);
			for (const title of ["Open settings…", "Add changes view", "Add Markdown view…", "Open saved view…"])
				assert.ok(!titles.includes(title), `guest sees ${title}: ${titles}`);
			// The settings search is the owner's too.
			await guest.call("Input.insertText", { text: "providers" });
			await guest.wait(`document.querySelector('.command-menu .empty-note')?.textContent==='No results'`);
		} finally {
			await guest.close();
			sharing.release();
			views.release();
		}
	});
});
