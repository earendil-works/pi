// Browser: the command menu (Cmd+K) at 1280×800: the key per platform (Cmd on macOS,
// Ctrl elsewhere, emulated through navigator.platform) from anywhere and from the composer, focus and caret back on
// close, a key a focused component consumed (the terminal's Ctrl+K) left alone, filtering and ranking, the keys, pages
// with Backspace and Back, the target chip, and the sessions' and the chat's commands (new, switch, rename, archive and
// restore, session search, change model, thinking level, default model) for the owner and a guest. Fake provider with a
// second, reasoning model from models.json and a key in auth.json (the pickers list signed-in providers only);
// disposable data, every test makes its own sessions.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Subagents } from "../../plugins/subagents/contract.ts";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import { encodeFrame } from "../../plugins/terminals/protocol.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { APP, type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

type Platform = "mac" | "other";

/** What the open menu shows, or null while it is closed. */
type MenuState = {
	chip: string | null;
	crumbs: string[];
	query: string;
	placeholder: string;
	/** The groups on screen (a group without rows is hidden by CSS), each with its rows' titles. */
	groups: [string, string[]][];
	selected: string | null;
	count: string;
	empty: boolean;
	focused: boolean;
};

const MENU = `(() => {
	const menu = document.querySelector('.command-menu');
	if (!menu) return null;
	const input = menu.querySelector('input[role=combobox]');
	return {
		chip: menu.querySelector('.command-chip')?.textContent ?? null,
		crumbs: [...menu.querySelectorAll('.command-crumb')].map((e) => e.textContent),
		query: input.value,
		placeholder: input.placeholder,
		groups: [...menu.querySelectorAll('.command-group')].filter((g) => getComputedStyle(g).display !== 'none').map((g) => [g.querySelector('.command-heading').textContent, [...g.querySelectorAll('[role=option] .command-title')].map((e) => e.textContent)]),
		selected: menu.querySelector('[role=option][aria-selected=true] .command-title')?.textContent ?? null,
		count: menu.querySelector('.command-count').textContent,
		empty: Boolean(menu.querySelector('.empty-note')),
		focused: document.activeElement === input,
	};
})()`;

/** Whether the menu is open, as an expression. */
const OPEN = `Boolean(document.querySelector('.command-menu'))`;
const CLOSED = `!document.querySelector('.command-menu')`;
/** Every row title of the open menu, as an expression. */
const TITLES = `[...document.querySelectorAll('.command-menu [role=option] .command-title')].map((e) => e.textContent)`;
const SELECTED = `document.querySelector('.command-menu [role=option][aria-selected=true] .command-title')?.textContent`;
const RECENTS = "p2-command-recents-v1";
/** Whether the announced count is the number of rows shown. */
const COUNTED = `(() => { const n = document.querySelectorAll('.command-menu [role=option]').length; return document.querySelector('.command-menu .command-count')?.textContent === (n === 1 ? '1 result' : n + ' results'); })()`;

/** The DevTools key fields of the keys the tests press; letters are derived. */
const KEYS: Record<string, { code: string; keyCode: number }> = {
	ArrowDown: { code: "ArrowDown", keyCode: 40 },
	ArrowUp: { code: "ArrowUp", keyCode: 38 },
	Enter: { code: "Enter", keyCode: 13 },
	Escape: { code: "Escape", keyCode: 27 },
	Backspace: { code: "Backspace", keyCode: 8 },
	Tab: { code: "Tab", keyCode: 9 },
};

/** The models.json of the fixture: the faux model with thinking, and a second one, so a change is visible. */
const MODELS_JSON = {
	providers: {
		faux: {
			modelOverrides: { "faux-1": { reasoning: true } },
			models: [{ id: "faux-2", name: "Faux Two", reasoning: true }],
		},
	},
};

let terminalUnavailable: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	terminalUnavailable = String(error);
}

describe("command menu", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let userAgent: string;
	let base: string;

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.dataDir, "models.json"), JSON.stringify(MODELS_JSON));
		// The pickers list signed-in providers' models only: a key for the faux provider (no real provider is called).
		writeFileSync(join(fixture.dataDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "fixture" } }), {
			mode: 0o600,
		});
		owner = fixture.browser();
		const models = await holdIn(owner, Models, {}, "owner");
		await until(models.resources, (resources) =>
			Boolean(
				resources?.models.some((model) => model.modelId === "faux-2") &&
					resources.credentials.some((credential) => credential.providerId === "faux"),
			),
		);
		await models.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
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

	/**
	 * Opens `path` at 1280×800 as a page on `platform` (the menu's key table reads navigator.platform at load) and waits
	 * for `ready` (a selector) while online.
	 */
	const load = async (path: string, platform: Platform = "mac", ready = ".composer textarea") => {
		await browser.metrics(1280, 800);
		await browser.call("Emulation.setUserAgentOverride", {
			userAgent,
			platform: platform === "mac" ? "MacIntel" : "Linux x86_64",
		});
		await browser.open(`${base}${path}`);
		await browser.evaluate(`localStorage.removeItem(${JSON.stringify(RECENTS)})`);
		await browser.wait(`document.querySelector(${JSON.stringify(ready)}) && !document.querySelector('.offline')`);
	};

	/** Opens a session's page and waits for its title in the top bar. */
	const openSession = async (id: string, title: string, platform: Platform = "mac") => {
		await load(`/s/${id}`, platform);
		await browser.wait(`document.querySelector('.topbar h1')?.textContent===${JSON.stringify(title)}`);
	};

	/** Presses `key` (a name of KEYS or a letter) with the given modifiers, as a real keyboard would. */
	const press = async (key: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => {
		const known = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
		const flags = (modifiers.ctrl ? 2 : 0) | (modifiers.meta ? 4 : 0);
		const event = { key, code: known.code, windowsVirtualKeyCode: known.keyCode, modifiers: flags };
		await browser.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
		await browser.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
	};

	/** Cmd+K on macOS, Ctrl+K elsewhere. */
	const commandK = (platform: Platform = "mac") => press("k", platform === "mac" ? { meta: true } : { ctrl: true });

	const type = (text: string) => browser.call("Input.insertText", { text });

	const menu = () => browser.evaluate<MenuState | null>(MENU);

	/**
	 * Opens the menu and waits for its input to have focus and its rows to settle: rows behind a `Shown` wrapper (Archive
	 * session) appear once their plugin's state arrived, and the count follows them.
	 */
	const openMenu = async (platform: Platform = "mac") => {
		await commandK(platform);
		await browser.wait(`${OPEN} && document.activeElement?.matches('.command-menu input')`);
		await browser.wait(COUNTED);
	};

	/** Types `query` into the open menu and waits until the highlighted row is `title`, then presses Enter. */
	const run = async (query: string, title: string) => {
		await type(query);
		await browser
			.wait(`${SELECTED}===${JSON.stringify(title)}`)
			.catch(async () => assert.fail(`"${title}" not highlighted: ${JSON.stringify(await menu())}`));
		await press("Enter");
	};

	/** Moves the mouse to the middle of the element `expression` evaluates to. */
	const hover = async (expression: string) => {
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	};

	/** The selector of a session's main row in the sidebar's Recents. */
	const sidebarRow = (id: string) =>
		`.sidebar-section[data-key=recent] .nav-row:has(> a.session-main[href="/s/${id}"])`;

	describe("keys and focus", () => {
		it("opens and closes with Cmd+K on macOS, Ctrl+K elsewhere, from the composer, and gives the composer its caret back", async () => {
			for (const platform of ["mac", "other"] as const) {
				// A session per platform: the composer's draft is kept per session.
				await openSession(await create(`Keys ${platform}`), `Keys ${platform}`, platform);
				// The composer has the focus and a caret in the middle of its text.
				await browser.evaluate(`document.querySelector('.composer textarea').focus()`);
				await type("hello world");
				await browser.evaluate(`document.querySelector('.composer textarea').setSelectionRange(5, 5)`);
				// The other platform's chord does nothing.
				await press("k", platform === "mac" ? { ctrl: true } : { meta: true });
				await new Promise((resolve) => setTimeout(resolve, 200));
				assert.equal(await browser.evaluate<boolean>(OPEN), false, `${platform}: the other modifier`);
				await openMenu(platform);
				const open = await menu();
				assert.equal(open?.focused, true);
				assert.equal(open?.placeholder, "Type a command or search…");
				// Focus stays in the menu: Tab does not leave the input.
				await press("Tab");
				assert.equal((await menu())?.focused, true);
				// The chord again closes it; the composer has its focus and caret back, its text untouched.
				await commandK(platform);
				await browser.wait(CLOSED);
				assert.deepEqual(
					await browser.evaluate(
						`(() => { const e = document.querySelector('.composer textarea'); return [document.activeElement === e, e.selectionStart, e.selectionEnd, e.value]; })()`,
					),
					[true, 5, 5, "hello world"],
					platform,
				);
				// Escape closes it too, with the same focus return; so does a click on the scrim.
				await openMenu(platform);
				await press("Escape");
				await browser.wait(CLOSED);
				assert.equal(
					await browser.evaluate<boolean>(
						`document.activeElement === document.querySelector('.composer textarea')`,
					),
					true,
				);
				await openMenu(platform);
				await browser.clickPoint(20, 780);
				await browser.wait(CLOSED);
			}
			// From anywhere in the page: focus on the body (the page is the other platform's now).
			await browser.evaluate(`document.activeElement.blur()`);
			await openMenu("other");
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it("leaves a Ctrl+K a focused component consumed first", async () => {
			const id = await create("Consumed");
			await openSession(id, "Consumed", "other");
			// A component that handles Ctrl+K itself (as the terminal does) calls preventDefault on its keydown.
			await browser.evaluate(
				`(() => { const e = document.createElement('textarea'); e.id = 'consumer'; e.addEventListener('keydown', (event) => { if (event.key === 'k') event.preventDefault(); }); document.body.append(e); e.focus(); })()`,
			);
			await press("k", { ctrl: true });
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(await browser.evaluate<boolean>(OPEN), false);
			await browser.evaluate(`document.getElementById('consumer').remove()`);
			await openMenu("other");
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it(
			"sends Ctrl+K inside the terminal to the shell, while Cmd+K opens the menu there",
			{ skip: terminalUnavailable },
			async () => {
				const shell = process.env.SHELL;
				process.env.SHELL = "/bin/sh";
				// The bytes the terminal sends to its shell, recorded at its socket on every page of this test.
				const { identifier } = (await browser.call("Page.addScriptToEvaluateOnNewDocument", {
					source: `window.terminalBytes=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){if(String(this.url).includes('/terminal')&&data instanceof Uint8Array)window.terminalBytes.push(...data);return send.call(this,data);};`,
				})) as { identifier: string };
				try {
					const id = await create("Terminal keys");
					for (const platform of ["other", "mac"] as const) {
						await openSession(id, "Terminal keys", platform);
						if (!(await browser.evaluate<boolean>(`Boolean(document.querySelector('.terminal-row'))`)))
							await browser.click(".topbar button[aria-label=Terminal]");
						await browser.wait(
							`[...document.querySelectorAll('.terminal-row')].some((row) => /[$#]/.test(row.textContent))`,
						);
						await browser.evaluate(`document.querySelector('.terminal-input').focus()`);
						await press("k", { ctrl: true });
						// Ctrl+K is the shell's (0x0b, kill to the end of the line): the menu stays closed.
						await browser.wait(`window.terminalBytes.includes(11)`);
						assert.equal(await browser.evaluate<boolean>(OPEN), false, platform);
						if (platform === "mac") {
							// Cmd+K is never the shell's: it opens the menu from the terminal, and closing gives the terminal its focus back.
							await press("k", { meta: true });
							await browser.wait(OPEN);
							await press("Escape");
							await browser.wait(`${CLOSED} && document.activeElement?.matches('.terminal-input')`);
						}
					}
				} finally {
					await browser.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
					const host = await connectTerminalHost(fixture.dataDir, APP);
					host.resume();
					host.write(encodeFrame({ type: "shutdown" }));
					await new Promise((resolve) => host.once("close", resolve));
					if (shell === undefined) delete process.env.SHELL;
					else process.env.SHELL = shell;
				}
			},
		);
	});

	describe("filtering and pages", () => {
		it("filters and ranks as the reader types, hides empty groups and updates the count", async () => {
			const id = await create("Filtering");
			await openSession(id, "Filtering");
			await openMenu();
			const all = await menu();
			assert.equal(all?.chip, "Session · Filtering");
			const total = all!.groups.flatMap(([, rows]) => rows).length;
			assert.equal(all?.count, `${total} results`);
			// The session's commands come before the global ones.
			const headings = all!.groups.map(([heading]) => heading);
			assert.ok(
				headings.includes("Model") && headings.indexOf("Session") < headings.indexOf("Model"),
				String(headings),
			);
			// "arch": the Archive command, best first; the Model group has no row and hides.
			await type("arch");
			await browser.wait(`${SELECTED}==='Archive session'`);
			const typed = await menu();
			assert.ok(!typed!.groups.some(([heading]) => heading === "Model"), JSON.stringify(typed?.groups));
			// A group without rows stays in the list, hidden by CSS (the session search's group renders its own rows).
			assert.equal(
				await browser.evaluate<boolean>(
					`[...document.querySelectorAll('.command-menu .command-group')].every((g) => g.querySelector('[role=option]') || getComputedStyle(g).display === 'none')`,
				),
				true,
			);
			assert.ok(typed!.groups.every(([, rows]) => rows.length > 0));
			const rows = typed!.groups.flatMap(([, titles]) => titles);
			assert.equal(typed?.count, rows.length === 1 ? "1 result" : `${rows.length} results`);
			// Groups keep their order while typing: "switch" puts the Session group (Switch session…) before the Model group
			// (Change model…, by its keyword "switch model").
			for (let i = 0; i < 4; i++) await press("Backspace");
			await type("switch");
			await browser.wait(`${TITLES}.includes('Switch session…')`);
			assert.equal(await browser.evaluate(SELECTED), "Switch session…", JSON.stringify(await menu()));
			// "model": ranked inside the Model group, "Change model…" (a word start) above "Set default model…".
			for (let i = 0; i < 6; i++) await press("Backspace");
			await type("model");
			await browser.wait(`${SELECTED}==='Change model…'`);
			const model = (await menu())!.groups.find(([heading]) => heading === "Model")?.[1] ?? [];
			assert.ok(model.indexOf("Change model…") < model.indexOf("Set default model…"), String(model));
			// Nothing matches: "No results", and the count says so.
			await browser.evaluate(`(() => { const e = document.querySelector('.command-menu input'); e.select(); })()`);
			await type("zzqx");
			await browser.wait(`document.querySelector('.command-menu .empty-note')?.textContent==='No results'`);
			assert.equal((await menu())?.count, "0 results");
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it("moves the highlight with Up/Down (wrapping) and runs it with Enter", async () => {
			const id = await create("Highlight");
			await openSession(id, "Highlight");
			await openMenu();
			// Archive session renders behind its `Shown` wrapper a moment later: read the rows once it is there.
			await browser.wait(`${TITLES}.includes('Archive session')`);
			const titles = await browser.evaluate<string[]>(TITLES);
			assert.ok(titles.length > 2);
			assert.equal(await browser.evaluate(SELECTED), titles[0]);
			await press("ArrowDown");
			assert.equal(await browser.evaluate(SELECTED), titles[1]);
			await press("ArrowUp");
			await press("ArrowUp");
			assert.equal(await browser.evaluate(SELECTED), titles.at(-1));
			await press("ArrowDown");
			assert.equal(await browser.evaluate(SELECTED), titles[0]);
			// The input keeps the focus and points at the highlighted option.
			assert.equal(
				await browser.evaluate<boolean>(
					`document.activeElement.getAttribute('aria-activedescendant') === document.querySelector('.command-menu [role=option][aria-selected=true]').id`,
				),
				true,
			);
			// A query starts again at its first row; Enter runs "New session".
			await run("new sess", "New session");
			await browser.wait(`${CLOSED} && location.pathname==='/new'`);
		});

		it("keeps the first row highlighted when rows appear above it later; a real mouse move highlights the row under it", async () => {
			const id = await create("Late rows");
			await openSession(id, "Late rows");
			await openMenu();
			await run("change model", "Change model…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')`);
			await press("Escape");
			await browser.wait(CLOSED);
			// "Change model…" is now in Recent, behind a `Shown` wrapper that renders it a moment after the menu opens: the
			// first row before it arrives (Rename session…) must not keep the highlight.
			await openMenu();
			await browser.wait(`${TITLES}[0]==='Change model…'`);
			assert.equal(await browser.evaluate(SELECTED), "Change model…");
			// A mouse move highlights the row under it.
			const third = `document.querySelectorAll('.command-menu [role=option]')[2]`;
			const title = await browser.evaluate<string>(`${third}.querySelector('.command-title').textContent`);
			await hover(third);
			await browser.wait(`${SELECTED}===${JSON.stringify(title)}`);
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it("goes up a page with Backspace, restoring its query, then removes the chip", async () => {
			const id = await create("Backspace pages");
			await openSession(id, "Backspace pages");
			await openMenu();
			assert.equal((await menu())?.chip, "Session · Backspace pages");
			await run("switch sess", "Switch session…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')`);
			await browser.wait(`${TITLES}.includes('Backspace pages')`);
			const page = await menu();
			assert.deepEqual([page?.crumbs, page?.query, page?.placeholder], [["Sessions"], "", "Search sessions…"]);
			await type("ba");
			await press("Backspace");
			await press("Backspace");
			await browser.wait(`document.querySelector('.command-menu input').value===''`);
			assert.deepEqual((await menu())?.crumbs, ["Sessions"]);
			// On the empty input: up to the root, whose query is back.
			await press("Backspace");
			await browser.wait(`!document.querySelector('.command-menu .command-crumb')`);
			assert.equal((await menu())?.query, "switch sess");
			for (let i = 0; i < "switch sess".length; i++) await press("Backspace");
			await browser.wait(`document.querySelector('.command-menu input').value===''`);
			assert.equal((await menu())?.chip, "Session · Backspace pages");
			// At the root's empty input: the chip goes, and the session's commands with it.
			await press("Backspace");
			await browser.wait(`!document.querySelector('.command-menu .command-chip')`);
			await browser.wait(`${TITLES}.includes('New session') && !${TITLES}.includes('Archive session')`);
			// Nothing more to remove: the menu stays.
			await press("Backspace");
			assert.equal(await browser.evaluate<boolean>(OPEN), true);
			await press("Escape");
			await browser.wait(CLOSED);
			assert.equal(await browser.evaluate<string>(`location.pathname`), `/s/${id}`);
		});

		it("goes up a page with history.back(), then closes", async () => {
			const id = await create("Back pages");
			await openSession(id, "Back pages");
			await openMenu();
			await run("switch sess", "Switch session…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')`);
			await browser.evaluate("history.back()");
			await browser.wait(`${OPEN} && !document.querySelector('.command-menu .command-crumb')`);
			assert.equal((await menu())?.query, "switch sess");
			await browser.evaluate("history.back()");
			await browser.wait(CLOSED);
			assert.equal(await browser.evaluate<string>(`location.pathname`), `/s/${id}`);
		});
	});

	describe("session commands", () => {
		it("starts a new session", async () => {
			const id = await create("From here");
			await openSession(id, "From here");
			await openMenu();
			await run("new", "New session");
			await browser.wait(`${CLOSED} && location.pathname==='/new' && document.querySelector('.new-session-view')`);
		});

		it("switches session from its page; Back returns to the previous one without the menu", async () => {
			const from = await create("Switch from");
			const to = await create("Switch target");
			await openSession(from, "Switch from");
			await openMenu();
			await run("switch sess", "Switch session…");
			await run("target", "Switch target");
			await browser.wait(`${CLOSED} && location.pathname==='/s/${to}'`);
			await browser.wait(`document.querySelector('.topbar h1')?.textContent==='Switch target'`);
			await browser.evaluate("history.back()");
			await browser.wait(`location.pathname==='/s/${from}' && ${CLOSED}`);
			await browser.wait(`document.querySelector('.topbar h1')?.textContent==='Switch from'`);
		});

		it("opens a session typed at the root by its title", async () => {
			const from = await create("Root search from");
			const to = await create("Quokka notes");
			await openSession(from, "Root search from");
			await openMenu();
			await run("quokka", "Quokka notes");
			await browser.wait(`${CLOSED} && location.pathname==='/s/${to}'`);
		});

		it("lists the sessions a query matches under Sessions, after the commands, the open one checked", async () => {
			const id = await create("Change model notes");
			await openSession(id, "Change model notes");
			await openMenu();
			// The command it names comes first; the session whose title matches follows in a group of its own.
			await type("change model");
			await browser.wait(`${SELECTED}==='Change model…'`);
			await poll(
				async () =>
					(await menu())!.groups.some(
						([heading, titles]) => heading === "Sessions" && titles.includes("Change model notes"),
					),
				10_000,
				"the session under Sessions",
			);
			const headings = (await menu())!.groups.map(([heading]) => heading);
			assert.ok(headings.indexOf("Model") < headings.indexOf("Sessions"), String(headings));
			assert.equal(
				await browser.evaluate(
					`[...document.querySelectorAll('.command-menu [role=option]')].find((e) => e.querySelector('.command-title').textContent === 'Change model notes').getAttribute('aria-checked')`,
				),
				"true",
			);
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it("renames a session", async () => {
			const id = await create("Before rename");
			await openSession(id, "Before rename");
			await openMenu();
			await run("rename", "Rename session…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')`);
			await run("After rename", "Rename to “After rename”");
			await browser.wait(CLOSED);
			await browser.wait(`document.querySelector('.topbar h1')?.textContent==='After rename'`);
			await browser.wait(
				`document.querySelector(${JSON.stringify(`${sidebarRow(id)} .session-title`)})?.textContent==='After rename'`,
			);
			await until(sessions.sessions, (rows) => rows?.find((row) => row.id === id)?.title === "After rename");
		});

		it("says what an empty page needs, and Enter right after typing runs the row for the text typed", async () => {
			const id = await create("Quick rename");
			await openSession(id, "Quick rename");
			await openMenu();
			await run("rename", "Rename session…");
			await browser.wait(`document.querySelector('.command-menu .empty-note')?.textContent==='Type the new title'`);
			await type("First");
			await browser.wait(`${SELECTED}==='Rename to “First”'`);
			// One burst: the Enter arrives while the list may still show the rows for "First" (it filters on the deferred
			// query); it renders the list for the whole text first, then runs its row.
			await Promise.all([type(" second"), press("Enter")]);
			await browser.wait(CLOSED);
			await until(sessions.sessions, (rows) => rows?.find((row) => row.id === id)?.title === "First second");
		});

		it("archives the open session (its row goes, the new-session screen shows) and restores it", async () => {
			const id = await create("To archive");
			await openSession(id, "To archive");
			await openMenu();
			await run("archive", "Archive session");
			await browser.wait(`${CLOSED} && location.pathname==='/new'`);
			await browser.wait(`!document.querySelector(${JSON.stringify(sidebarRow(id))})`);
			await until(sessions.sessions, (rows) => Boolean(rows?.find((row) => row.id === id)?.archivedAt));
			// An archived session does not open (its page gives way to the new-session screen): its row in the Archive's list
			// is the target, and offers Restore, not Archive.
			await load("/list/archive", "mac", ".list-page .session-row");
			const row = `[...document.querySelectorAll('.list-page .session-row')].find((e) => e.querySelector('.session-title')?.textContent === 'To archive')`;
			await browser.wait(row);
			await hover(row);
			await openMenu();
			assert.equal((await menu())?.chip, "Session · To archive");
			// Restore's `Shown` wrapper renders its row once the freshly loaded page has the session's archived state.
			await browser.wait(`${TITLES}.includes('Restore session')`);
			const titles = await browser.evaluate<string[]>(TITLES);
			assert.ok(!titles.includes("Archive session"), String(titles));
			// An archived session's worker does not start: no model change for it.
			assert.ok(!titles.some((title) => title === "Change model…" || title === "Thinking level…"), String(titles));
			await run("restore", "Restore session");
			await browser.wait(`${CLOSED} && location.pathname.startsWith('/s/${id}')`);
			await until(sessions.sessions, (rows) => rows?.find((row) => row.id === id)?.archivedAt === null);
			await browser.wait(`document.querySelector(${JSON.stringify(sidebarRow(id))})`);
		});

		it("targets the sidebar row under the mouse", async () => {
			const open = await create("Open one");
			const hovered = await create("Hovered one");
			await openSession(open, "Open one");
			await browser.wait(`document.querySelector(${JSON.stringify(sidebarRow(hovered))})`);
			await hover(`document.querySelector(${JSON.stringify(sidebarRow(hovered))})`);
			await openMenu();
			assert.equal((await menu())?.chip, "Session · Hovered one");
			// Its commands act on that row's session, not on the open one.
			await run("rename", "Rename session…");
			await run("Hovered renamed", "Rename to “Hovered renamed”");
			await browser.wait(CLOSED);
			await until(sessions.sessions, (rows) => rows?.find((row) => row.id === hovered)?.title === "Hovered renamed");
			assert.equal(await browser.evaluate(`document.querySelector('.topbar h1')?.textContent`), "Open one");
			// The mouse leaves: the open session is the target again.
			await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 });
			await openMenu();
			assert.equal((await menu())?.chip, "Session · Open one");
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it("lists a command run from the menu in the Recent group next time", async () => {
			const id = await create("Recents");
			await openSession(id, "Recents");
			await openMenu();
			assert.ok(!(await menu())!.groups.some(([heading]) => heading === "Recent"));
			await run("switch sess", "Switch session…");
			await press("Escape");
			await browser.wait(CLOSED);
			await openMenu();
			const groups = (await menu())!.groups;
			assert.deepEqual(groups[0], ["Recent", ["Switch session…"]]);
			// Not twice: while it shows in Recent its own group leaves it out; typing ranks it in its group again.
			assert.ok(!groups.slice(1).some(([, titles]) => titles.includes("Switch session…")), JSON.stringify(groups));
			// The list filters on the deferred query: wait for the typed one's groups (no Recent group).
			await type("switch sess");
			await poll(
				async () => {
					const typed = (await menu())!.groups;
					return (
						!typed.some(([heading]) => heading === "Recent") &&
						typed.some(([heading, titles]) => heading === "Session" && titles.includes("Switch session…"))
					);
				},
				10_000,
				"Switch session… in its group while typing",
			);
			await press("Escape");
			await browser.wait(CLOSED);
		});
	});

	describe("model commands", () => {
		it("changes the model and the thinking level of the open session", async () => {
			const id = await create("Model change");
			await openSession(id, "Model change");
			await browser.wait(`document.querySelector('.model-control')?.getAttribute('title')==='Faux Model'`);
			await openMenu();
			await run("change model", "Change model…");
			await browser.wait(`document.querySelector('.command-menu input')?.placeholder==='Search models…'`);
			await run("two", "Faux Two");
			await browser.wait(
				`${CLOSED} && document.querySelector('.model-control')?.getAttribute('title')==='Faux Two'`,
			);
			await openMenu();
			await run("thinking", "Thinking level…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')`);
			await run("high", "high");
			await browser.wait(
				`${CLOSED} && document.querySelector('.model-control')?.getAttribute('title')==='Faux Two · high'`,
			);
			// The session keeps it: the page loads it again from the server.
			await openSession(id, "Model change");
			await browser.wait(`document.querySelector('.model-control')?.getAttribute('title')==='Faux Two · high'`);
			// The default for new sessions is untouched.
			const models = await holdIn(owner, Models, {}, "owner");
			assert.deepEqual(models.defaultModel.value, { provider: "faux", modelId: "faux-1", thinkingLevel: "off" });
		});

		it("changes the model and the thinking level of a subagent's conversation only", async () => {
			const session = await create("With helper");
			const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
			const list = await holdIn(owner, Subagents, {}, "reader");
			await chat.send({ text: "subagent", requestId: "menu-spawn" }, BACKGROUND_CONTEXT);
			const children = await until(list.children, (value) => value?.[session]?.length === 1);
			const helper = children![session]![0]!;
			chat.release();
			await load(`/s/${session}/c/${helper.conversationId}`);
			await browser.wait(`document.querySelector('.model-control')?.getAttribute('title')==='Faux Model · high'`);
			await openMenu();
			assert.equal((await menu())?.chip, "Conversation · helper");
			await run("change model", "Change model…");
			await run("two", "Faux Two");
			await browser.wait(
				`${CLOSED} && document.querySelector('.model-control')?.getAttribute('title')==='Faux Two · high'`,
			);
			await openMenu();
			await run("thinking", "Thinking level…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')`);
			await run("low", "low");
			await browser.wait(
				`${CLOSED} && document.querySelector('.model-control')?.getAttribute('title')==='Faux Two · low'`,
			);
			// The session's main conversation keeps its model.
			await openSession(session, "With helper");
			await browser.wait(`document.querySelector('.model-control')?.getAttribute('title')==='Faux Model'`);
		});

		it("sets the default model for new sessions", async () => {
			const id = await create("Default model");
			await openSession(id, "Default model");
			const models = await holdIn(owner, Models, {}, "owner");
			await openMenu();
			await run("default", "Set default model…");
			await browser.wait(`document.querySelector('.command-menu input')?.placeholder==='Search models…'`);
			await run("two", "Faux Two");
			await browser.wait(CLOSED);
			await until(models.defaultModel, (choice) => choice?.modelId === "faux-2");
			// The open session keeps its model.
			assert.equal(
				await browser.evaluate(`document.querySelector('.model-control').getAttribute('title')`),
				"Faux Model",
			);
			await models.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		});
	});

	it("shows a guest no owner commands", async () => {
		const id = await create("Shared with guest");
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
			for (const type of ["rawKeyDown", "keyUp"])
				await guest.call("Input.dispatchKeyEvent", {
					type,
					key: "k",
					code: "KeyK",
					windowsVirtualKeyCode: 75,
					modifiers: 4,
				});
			await guest.wait(OPEN);
			await guest.wait(`${TITLES}.includes('Switch session…')`);
			const titles = await guest.evaluate<string[]>(TITLES);
			for (const title of [
				"New session",
				"Rename session…",
				"Archive session",
				"Restore session",
				"Change model…",
				"Thinking level…",
				"Set default model…",
			])
				assert.ok(!titles.includes(title), `guest sees ${title}: ${titles}`);
		} finally {
			await guest.close();
			sharing.release();
		}
	});
});
