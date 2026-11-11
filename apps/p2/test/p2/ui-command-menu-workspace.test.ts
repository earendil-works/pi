// Browser: the command menu's workspace, terminal, folder and working directory commands at 1280×800: Browse files,
// Show changes and Search files (the workspace's tabs, in the open session and in a hovered row's), Open terminal and
// New terminal, Change working directory… on a session (the picker, then the move) and on the new-session screen, New
// session in folder… and Open folder… (pages of the sidebar's folders), and which of them guests see. Fake provider;
// disposable data, every test makes its own sessions.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { localSystem, terminalDaemon } from "../../plugins/terminals/daemon.ts";
import { connectTerminalHost } from "../../plugins/terminals/detached.ts";
import { encodeFrame } from "../../plugins/terminals/protocol.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { APP, type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** Whether the menu is open or closed, as expressions. */
const OPEN = `Boolean(document.querySelector('.command-menu'))`;
const CLOSED = `!document.querySelector('.command-menu')`;
/** Every row title of the open menu, and the highlighted one, as expressions. */
const TITLES = `[...document.querySelectorAll('.command-menu [role=option] .command-title')].map((e) => e.textContent)`;
const SELECTED = `document.querySelector('.command-menu [role=option][aria-selected=true] .command-title')?.textContent`;
/** Whether the announced count is the number of rows shown. */
const COUNTED = `(() => { const n = document.querySelectorAll('.command-menu [role=option]').length; return document.querySelector('.command-menu .command-count')?.textContent === (n === 1 ? '1 result' : n + ' results'); })()`;
/** The workspace's selected tab, as an expression (undefined while the workspace is closed). */
const TAB = `document.querySelector('.workspace-tabs button[aria-pressed=true]')?.title`;
/** How many terminals the shown terminal panel lists, as an expression. */
const TERMINALS = `[...document.querySelectorAll('.terminal-tabs > button')].filter((b) => /^\\d+: /.test(b.title)).length`;
/** The sheet's title, as an expression. */
const SHEET = `document.querySelector('.sheet-head h2')?.textContent`;

/** The DevTools key fields of the keys the tests press. */
const KEYS: Record<string, { code: string; keyCode: number }> = {
	Enter: { code: "Enter", keyCode: 13 },
	Escape: { code: "Escape", keyCode: 27 },
	k: { code: "KeyK", keyCode: 75 },
};

let terminalUnavailable: string | undefined;
try {
	const system = localSystem();
	await terminalDaemon(system.platform, system.arch, true);
} catch (error) {
	terminalUnavailable = String(error);
}

describe("command menu: workspace, terminal and folders", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let sessions: RefIn<typeof Sessions, "owner">;
	let userAgent: string;
	let base: string;

	before(async () => {
		fixture = await startFixture({ web: true });
		sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		userAgent = ((await browser.call("Browser.getVersion")) as { userAgent: string }).userAgent;
		base = `http://127.0.0.1:${fixture.server.port}`;
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	/** A session in `cwd` (default: the fixture's workspace). */
	const create = async (title: string, cwd = fixture.workspace) =>
		(await sessions.create({ cwd, title }, BACKGROUND_CONTEXT)).id;

	/** A folder of the fixture's workspace, made for the test. */
	const folder = (name: string) => {
		const path = join(fixture.workspace, name);
		mkdirSync(path, { recursive: true });
		return path;
	};

	/** Opens `path` at 1280×800 as a page on macOS and waits for `ready` (a selector) while online. */
	const load = async (path: string, ready = ".composer textarea") => {
		await browser.metrics(1280, 800);
		await browser.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
		await browser.open(`${base}${path}`);
		await browser.evaluate(`localStorage.removeItem('p2-command-recents-v1')`);
		await browser.wait(`document.querySelector(${JSON.stringify(ready)}) && !document.querySelector('.offline')`);
	};

	/** Opens a session's page and waits for its title in the top bar. */
	const openSession = async (id: string, title: string) => {
		await load(`/s/${id}`);
		await browser.wait(`document.querySelector('.topbar h1')?.textContent===${JSON.stringify(title)}`);
	};

	/** Presses `key` (a name of KEYS) with the given modifiers, as a real keyboard would. */
	const press = async (key: string, modifiers: { meta?: boolean } = {}) => {
		const known = KEYS[key]!;
		const event = { key, code: known.code, windowsVirtualKeyCode: known.keyCode, modifiers: modifiers.meta ? 4 : 0 };
		await browser.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
		await browser.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
	};

	const type = (text: string) => browser.call("Input.insertText", { text });

	/** Opens the menu (Cmd+K) and waits for its rows to settle (rows behind `Shown` wrappers come a moment later). */
	const openMenu = async () => {
		await press("k", { meta: true });
		await browser.wait(`${OPEN} && document.activeElement?.matches('.command-menu input')`);
		await browser.wait(COUNTED);
	};

	/** Types `query` into the open menu, waits until the highlighted row is `title`, then presses Enter. */
	const run = async (query: string, title: string) => {
		await type(query);
		await browser
			.wait(`${SELECTED}===${JSON.stringify(title)}`)
			.catch(async () => assert.fail(`"${title}" not highlighted: ${await browser.evaluate(TITLES)}`));
		await press("Enter");
	};

	/** Moves the mouse to the middle of the element `expression` evaluates to. */
	const hover = async (expression: string) => {
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	};

	/** Clicks the directory picker's row of the folder `name`. */
	const pickFolder = async (name: string) => {
		const row = `[...document.querySelectorAll('.sheet .row-button.mono')].find((e) => e.textContent.trim() === ${JSON.stringify(name)})`;
		await browser.wait(row);
		await browser.evaluate(`${row}.click()`);
		await browser.wait(
			`document.querySelector('.directory-use')?.textContent.endsWith(${JSON.stringify(`/${name}`)})`,
		);
	};

	describe("workspace", () => {
		it("browses files, then shows changes and search as its tabs do: lateral, Back closes the workspace", async () => {
			const id = await create("Workspace tabs");
			await openSession(id, "Workspace tabs");
			await openMenu();
			await run("browse files", "Browse files");
			await browser.wait(`${CLOSED} && ${TAB}==='Files'`);
			await openMenu();
			await run("show changes", "Show changes");
			await browser.wait(`${CLOSED} && ${TAB}==='Changes'`);
			await openMenu();
			await run("search files", "Search files");
			await browser.wait(`${CLOSED} && ${TAB}==='Search'`);
			// Tabs replace each other: one Back closes the workspace.
			await browser.evaluate("history.back()");
			await browser.wait(`!document.querySelector('.workspace-tabs') && location.pathname==='/s/${id}'`);
		});

		it("opens a hovered row's session with its workspace in one step; Back returns", async () => {
			const from = await create("Workspace from");
			const to = await create("Workspace hovered");
			await openSession(from, "Workspace from");
			await hover(
				`document.querySelector('.sidebar-section[data-key=recent] .nav-row:has(> a.session-main[href="/s/${to}"])')`,
			);
			await openMenu();
			assert.equal(
				await browser.evaluate(`document.querySelector('.command-menu .command-chip')?.textContent`),
				"Session · Workspace hovered",
			);
			await run("show changes", "Show changes");
			await browser.wait(`${CLOSED} && location.pathname==='/s/${to}' && ${TAB}==='Changes'`);
			await browser.evaluate("history.back()");
			await browser.wait(`location.pathname==='/s/${from}' && !document.querySelector('.workspace-tabs')`);
		});
	});

	describe("terminal", { skip: terminalUnavailable }, () => {
		let shell: string | undefined;
		before(() => {
			shell = process.env.SHELL;
			process.env.SHELL = "/bin/sh";
		});
		after(async () => {
			const host = await connectTerminalHost(fixture.dataDir, APP);
			host.resume();
			host.write(encodeFrame({ type: "shutdown" }));
			await new Promise((resolve) => host.once("close", resolve));
			if (shell === undefined) delete process.env.SHELL;
			else process.env.SHELL = shell;
		});

		it("opens the terminal where the reader last had it, then hides Open terminal while it shows", async () => {
			const id = await create("Terminal open");
			await openSession(id, "Terminal open");
			await openMenu();
			await run("open terminal", "Open terminal");
			await browser.wait(`${CLOSED} && ${TAB}==='Terminal'`);
			await browser.wait(
				`[...document.querySelectorAll('.terminal-row')].some((row) => /[$#]/.test(row.textContent))`,
			);
			assert.equal(await browser.evaluate(TERMINALS), 1);
			await openMenu();
			await type("terminal");
			await browser.wait(`${TITLES}.includes('New terminal')`);
			assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Open terminal"));
			await press("Escape");
			await browser.wait(CLOSED);
		});

		it("opens a new terminal beside the shown one, and with the panel hidden opens the panel on a new one", async () => {
			const id = await create("Terminal new");
			await openSession(id, "Terminal new");
			await openMenu();
			await run("new terminal", "New terminal");
			// The session had none: the panel opens on one new terminal, not two.
			await browser.wait(`${CLOSED} && ${TAB}==='Terminal'`);
			await browser.wait(`${TERMINALS}===1 && document.querySelector('.terminal-tabs > button[aria-pressed=true]')`);
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(await browser.evaluate(TERMINALS), 1);
			// Shown: one more, and it is the one shown.
			await openMenu();
			await run("new terminal", "New terminal");
			await browser.wait(`${CLOSED} && ${TERMINALS}===2`);
			await browser.wait(
				`document.querySelector('.terminal-tabs > button[aria-pressed=true]')?.title.startsWith('2: ')`,
			);
			// Hidden: the panel opens on a new third one instead of the newest running.
			await browser.evaluate("history.back()");
			await browser.wait(`!document.querySelector('.workspace-tabs')`);
			await openMenu();
			await run("new terminal", "New terminal");
			await browser.wait(`${CLOSED} && ${TERMINALS}===3`);
			await browser.wait(
				`document.querySelector('.terminal-tabs > button[aria-pressed=true]')?.title.startsWith('3: ')`,
			);
		});
	});

	describe("working directory", () => {
		it("moves a session: the picker starts at its directory, choosing another moves it", async () => {
			folder("moved-here");
			const id = await create("Change directory");
			await openSession(id, "Change directory");
			// A worker still starting refuses a move: one answered message says it runs, and idles.
			const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
			await chat.send({ text: "hello", requestId: "change-directory" }, BACKGROUND_CONTEXT);
			await browser.wait(`document.querySelector('.messages .assistant')?.textContent.includes('Echo: hello')`);
			await openMenu();
			await run("change working", "Change working directory…");
			await browser.wait(`${CLOSED} && ${SHEET}==='Working directory'`);
			await browser.wait(
				`document.querySelector('.directory-use')?.textContent.endsWith(${JSON.stringify(`/${basename(fixture.workspace)}`)})`,
			);
			await pickFolder("moved-here");
			await browser.click(".directory-use");
			// The picker lists real paths (on macOS the temporary folder is behind a symlink).
			await until(sessions.sessions, (rows) =>
				Boolean(rows?.find((row) => row.id === id)?.cwd.endsWith("/moved-here")),
			);
			await browser.wait(`!document.querySelector('.sheet-head')`);
			await browser.wait(`document.querySelector('.topbar .title-cwd')?.textContent.endsWith('/moved-here')`);
		});

		it("sets where a new session starts on the new-session screen", async () => {
			folder("start-here");
			await load("/new");
			await openMenu();
			assert.equal(
				await browser.evaluate(`document.querySelector('.command-menu .command-chip')?.textContent`),
				"New session",
			);
			await run("change working", "Change working directory…");
			await browser.wait(`${CLOSED} && ${SHEET}==='Working directory'`);
			// The picker starts where the screen says the session starts (the latest session's directory).
			const shown = await browser.evaluate<string>(`document.querySelector('.cwd-pick span').textContent`);
			await browser.wait(
				`document.querySelector('.directory-use')?.textContent.endsWith(${JSON.stringify(`/${shown.split("/").at(-1)}`)})`,
			);
			await browser.evaluate(`history.back()`);
			await browser.wait(`!document.querySelector('.sheet-head')`);
			// From the workspace folder: its folder "start-here".
			await create("Latest in workspace");
			await openMenu();
			await run("change working", "Change working directory…");
			await browser.wait(`${SHEET}==='Working directory'`);
			await pickFolder("start-here");
			await browser.click(".directory-use");
			await browser.wait(`document.querySelector('.cwd-pick span')?.textContent.endsWith('/start-here')`);
		});

		it("is not offered for an archived session", async () => {
			const id = await create("Archived directory");
			await sessions.archive({ id }, BACKGROUND_CONTEXT);
			await load("/list/archive", ".list-page");
			const row = `[...document.querySelectorAll('.list-page .session-row')].find((e) => e.textContent.includes('Archived directory'))?.querySelector('.nav-row')`;
			await browser.wait(row);
			await hover(row);
			await openMenu();
			await browser.wait(`${TITLES}.includes('Restore session')`);
			const titles = await browser.evaluate<string[]>(TITLES);
			for (const title of ["Change working directory…", "Browse files", "Open terminal", "New terminal"])
				assert.ok(!titles.includes(title), `offered ${title}: ${titles}`);
			await press("Escape");
			await browser.wait(CLOSED);
		});
	});

	describe("folders", () => {
		it("starts a new session in a folder the sidebar knows", async () => {
			const path = folder("folder-new-one");
			await create("In folder one", path);
			await create("In folder two", folder("folder-new-two"));
			await openSession(await create("Folders from"), "Folders from");
			await openMenu();
			await run("new session in", "New session in folder…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')?.textContent==='New session'`);
			await browser.wait(`${TITLES}.includes('folder-new-one') && ${TITLES}.includes('folder-new-two')`);
			await run("new-one", "folder-new-one");
			await browser.wait(`${CLOSED} && location.pathname==='/new'`);
			await browser.wait(`document.querySelector('.cwd-pick span')?.textContent.endsWith('/folder-new-one')`);
		});

		it("opens a folder's list page, the open one checked", async () => {
			await create("Listed in folder", folder("folder-listed"));
			await openSession(await create("List from"), "List from");
			await openMenu();
			await run("open folder", "Open folder…");
			await browser.wait(`document.querySelector('.command-menu .command-crumb')?.textContent==='Folders'`);
			await run("folder-listed", "folder-listed");
			await browser.wait(`${CLOSED} && decodeURIComponent(location.pathname).startsWith('/list/folder:')`);
			await browser.wait(`document.querySelector('.list-page h1')?.textContent==='folder-listed'`);
			await browser.wait(`document.querySelector('.list-page a[href]')?.textContent.includes('Listed in folder')`);
			await openMenu();
			await run("open folder", "Open folder…");
			await browser.wait(
				`[...document.querySelectorAll('.command-menu [role=option][aria-checked=true] .command-title')].map((e) => e.textContent).join()==='folder-listed'`,
			);
			await press("Escape");
			await browser.wait(CLOSED);
		});
	});

	it("shows a guest who may write the workspace commands only, and one who may view none of them", async () => {
		for (const mode of ["full", "view"] as const) {
			const id = await create(`Guest ${mode}`);
			const sharing = fixture.browser().hold(Sharing, { session: id }, BACKGROUND_CONTEXT);
			await sharing.link({ mode }, BACKGROUND_CONTEXT);
			const links = await until(sharing.links, (value) => value?.some((link) => link.mode === mode));
			const link = links!.find((each) => each.mode === mode)!;
			const guest = await Browser.start();
			try {
				await guest.metrics(1280, 800);
				await guest.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
				// A fresh profile on loopback gets the join form and joins as a guest (loopback-join.test.ts).
				await guest.open(`${base}${new URL(link.url).pathname}`);
				await guest.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
				await guest.evaluate(
					`(() => { const input = document.querySelector('#name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Reader'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
				);
				await guest.click("#join button");
				await guest.wait(`document.querySelector('.subagent-bar, .composer textarea')`);
				for (const type of ["rawKeyDown", "keyUp"])
					await guest.call("Input.dispatchKeyEvent", {
						type,
						key: "k",
						code: "KeyK",
						windowsVirtualKeyCode: 75,
						modifiers: 4,
					});
				await guest.wait(`${OPEN} && ${TITLES}.includes('Switch session…')`);
				if (mode === "full") await guest.wait(`${TITLES}.includes('Browse files')`);
				else await new Promise((resolve) => setTimeout(resolve, 500));
				const titles = await guest.evaluate<string[]>(TITLES);
				const workspace = ["Browse files", "Show changes", "Search files"];
				for (const title of workspace)
					assert.equal(titles.includes(title), mode === "full", `${mode} guest, ${title}: ${titles}`);
				for (const title of [
					"Open terminal",
					"New terminal",
					"Change working directory…",
					"New session in folder…",
					"Open folder…",
				])
					assert.ok(!titles.includes(title), `${mode} guest sees ${title}: ${titles}`);
			} finally {
				await guest.close();
				sharing.release();
			}
		}
	});
});
