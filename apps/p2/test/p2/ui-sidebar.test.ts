// Browser: the sidebar's rollups on Elanor's side navigation (Recents, projects, folders, the Archive), groups shown
// only with relevant sessions, a rollup's or a group's name opening its list in the main area (aged sessions after the
// others, dimmed; the list's own search), collapsing rollups and groups, a rollup's window and place, a session
// selected in the one place it was opened from, a group's "+" starting a session in its folder or project, what a
// session does (working, unread) and its sum on collapsed groups and rollups and the menu button, and project glyphs on
// groups, on Recents' sessions and in the top bar. Fake provider, disposable data; every test makes its own sessions.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Projects } from "../../plugins/projects/contract.ts";
import { Sessions, SidebarSettings } from "../../plugins/sessions/contract.ts";
import { folderKey, projectKey } from "../../plugins/sessions/sidebar/model.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** Each rollup's key, then its sessions' titles, or its groups' names with their sessions' titles. */
const SECTIONS = `[...document.querySelectorAll('.sidebar-section')].map(s=>[s.dataset.key,s.querySelector('.sidebar-group')?[...s.querySelectorAll('.sidebar-group')].map(g=>[g.querySelector('.group-link').textContent,[...g.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)]):[...s.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)])`;

/** The main area's list: its group labels and titles, an aged one marked. */
const PAGE = `[...document.querySelectorAll('.list-page .list-group-link, .list-page .session-row')].map(e=>e.classList.contains('session-row')?e.querySelector('.session-main .session-title').textContent+(e.classList.contains('aged')?' aged':''):'# '+e.textContent)`;

/** The keys of the places where a session is selected. */
const SELECTED = `[...document.querySelectorAll('.sidebar-nav .nav-row.selected > .session-main')].map(e=>e.closest('[data-key]').dataset.key)`;

/** Clicks the button of the open sheet whose text is `text`. */
const clickInSheet = (text: string) =>
	`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`;

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;

/** A selector for the element with `attribute` equal to `value`, quoted for any value. */
const withAttribute = (attribute: string, value: string) => `[${attribute}=${JSON.stringify(value)}]`;

describe("sidebar rollups", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let root: string;
	let sessions: Awaited<ReturnType<typeof holdIn<typeof Sessions, "owner">>>;
	let settings: Awaited<ReturnType<typeof holdIn<typeof SidebarSettings, "owner">>>;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		sessions = await holdIn(owner, Sessions, {}, "owner");
		settings = await holdIn(owner, SidebarSettings, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	// Each test sees only its own sessions, in folders of its own, with the default settings.
	beforeEach(async (context) => {
		for (const row of sessions.sessions.value ?? [])
			if (!row.archivedAt) await sessions.archive({ id: row.id }, BACKGROUND_CONTEXT);
		for (const key of ["recent", "projects", "folders", "archive"]) {
			await settings.setWindow({ key, window: "3d" }, BACKGROUND_CONTEXT);
			await settings.setCollapsed({ key, collapsed: false }, BACKGROUND_CONTEXT);
		}
		await settings.setOrder({ order: [] }, BACKGROUND_CONTEXT);
		root = join(fixture.workspace, context.name.replace(/\W+/g, "-").slice(0, 40));
		mkdirSync(root, { recursive: true });
		await browser.metrics(1280, 900);
	});

	/** A folder of this test, made. */
	const folder = (name: string) => {
		const path = join(root, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const create = (title: string, cwd: string) => sessions.create({ cwd, title }, BACKGROUND_CONTEXT);

	it("shows every rollup, groups with relevant sessions, and opens a rollup's or a group's list from its name", async () => {
		const home = folder("home");
		const free = await create("Free", home);
		const other = await create("Other", folder("other"));
		const gone = await create("Gone", home);
		await sessions.archive({ id: gone.id }, BACKGROUND_CONTEXT);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${free.id}`);
		await browser.wait(`document.querySelectorAll('.sidebar-section[data-key=folders] .sidebar-group').length===2`);
		// No projects.json: Projects is there, collapsed or not, and says it has nothing to show.
		assert.deepEqual(await browser.evaluate(SECTIONS), [
			["recent", ["Other", "Free"]],
			["projects", []],
			[
				"folders",
				[
					["home", ["Free"]],
					["other", ["Other"]],
				],
			],
			["archive", []],
		]);
		assert.equal(
			await browser.evaluate<string>(
				`document.querySelector('.sidebar-section[data-key=projects] .sidebar-empty').textContent`,
			),
			"No activity",
		);
		assert.match(
			await browser.evaluate<string>(
				`document.querySelector('.sidebar-section[data-key=archive] .section-count').textContent`,
			),
			/^\d+$/,
		);
		// Rows are links: the browser opens one in another tab on a modified click.
		assert.equal(
			await browser.evaluate<string>(
				`document.querySelector('.sidebar-section[data-key=recent] a.session-main').getAttribute('href')`,
			),
			`/s/${other.id}`,
		);
		// A click anywhere in a row opens it: here between the title and the time.
		const blank = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const row = document.querySelector('.sidebar-section[data-key=recent] .nav-row:has(> a.session-main[href="/s/${other.id}"])'), title = row.querySelector('.nav-link').getBoundingClientRect(), time = row.querySelector('.session-time').getBoundingClientRect(); return { x: (title.right + time.left) / 2, y: title.top + title.height / 2 }; })()`,
		);
		for (const type of ["mousePressed", "mouseReleased"])
			await browser.call("Input.dispatchMouseEvent", { type, ...blank, button: "left", clickCount: 1 });
		await browser.wait(`location.pathname==='/s/${other.id}'`);
		// Folders' name lists every folder with its sessions; a folder's name there lists its own; Back returns.
		await browser.click(".sidebar-section[data-key=folders] .group-label");
		await browser.wait(
			`location.pathname==='/list/folders' && document.querySelectorAll('.list-page .session-row').length>=2`,
		);
		assert.deepEqual(
			(await browser.evaluate<string[]>(PAGE)).filter((entry) =>
				["# home", "Free", "# other", "Other"].includes(entry),
			),
			["# home", "Free", "# other", "Other"],
		);
		await browser.evaluate(
			`[...document.querySelectorAll('.list-page .list-group-link')].find(e=>e.textContent==='home').click()`,
		);
		await browser.wait(`document.querySelector('.list-page h1')?.textContent==='home'`);
		assert.deepEqual(await browser.evaluate(PAGE), ["Free"]);
		await browser.click(".list-page a.session-main");
		await browser.wait(`location.pathname==='/s/${free.id}'`);
		await browser.evaluate("history.back()");
		await browser.wait(`document.querySelector('.list-page h1')?.textContent==='home'`);
		// The Archive's list holds the archived session; opening it restores it.
		await browser.click(".sidebar-section[data-key=archive] .group-label");
		await browser.wait(`location.pathname==='/list/archive' && document.querySelector('.list-page .session-row')`);
		assert((await browser.evaluate<string[]>(PAGE)).includes("Gone"));
	});

	it("searches a group's list within its sessions only", async () => {
		const mine = await create("Wombat notes", folder("mine"));
		await create("Wombat elsewhere", folder("theirs"));
		await browser.open(
			`http://127.0.0.1:${fixture.server.port}/list/${encodeURIComponent(folderKey(null, join(root, "mine")))}`,
		);
		await browser.wait(`document.querySelector('.list-page input') && !document.querySelector('.offline')`);
		await browser.evaluate(setInput(".list-page input", "wombat"));
		await browser.wait(`document.querySelectorAll('.list-page .session-row').length===1`);
		assert.deepEqual(await browser.evaluate(PAGE), ["Wombat notes"]);
		// The search is kept with the list: Back from a session shows it again.
		await browser.click(".list-page a.session-main");
		await browser.wait(`location.pathname==='/s/${mine.id}'`);
		await browser.evaluate("history.back()");
		await browser.wait(`document.querySelector('.list-page input')?.value==='wombat'`);
	});

	it("puts aged sessions after the others in a list, dimmed, and keeps them and their groups out of the sidebar", async () => {
		const pinned = await create("Pinned old", folder("old"));
		await sessions.pin({ id: pinned.id, pinned: true }, BACKGROUND_CONTEXT);
		await create("Plain old", folder("old"));
		// The page's clock four days ahead: both sessions are older than the rollups' three days; the pinned one stays.
		const { identifier } = (await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `{const now=Date.now;Date.now=()=>now()+${4 * 24 * 60 * 60 * 1000};}`,
		})) as { identifier: string };
		try {
			await browser.open(`http://127.0.0.1:${fixture.server.port}/list/recent`);
			await browser.wait(`document.querySelectorAll('.list-page .session-row').length===2`);
			assert.deepEqual(await browser.evaluate(PAGE), ["Pinned old", "Plain old aged"]);
			// Dimmed: the aged row's title is another colour than the relevant one's.
			const color = (selector: string) =>
				browser.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color`);
			assert.notEqual(
				await color(".list-page .session-row.aged .session-title"),
				await color(".list-page .session-row:not(.aged) .session-title"),
			);
			assert.deepEqual((await browser.evaluate<[string, string[]][]>(SECTIONS))[0], ["recent", ["Pinned old"]]);
			// Forever keeps every session in view.
			await settings.setWindow({ key: "recent", window: "forever" }, BACKGROUND_CONTEXT);
			await browser.wait(
				`!document.querySelector('.list-page .aged') && document.querySelectorAll('.sidebar-section[data-key=recent] .session-main').length===2`,
			);
		} finally {
			await browser.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
		}
	});

	it("selects an open session in one place: where it was opened from, else the first place it shows", async () => {
		const home = folder("home");
		const first = await create("First", home);
		const second = await create("Second", home);
		const homeKey = folderKey(null, home);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${first.id}`);
		await browser.wait(`${SELECTED}.length===1`);
		assert.deepEqual(await browser.evaluate(SELECTED), ["recent"]);
		// Opened from its folder: selected there only, after a reload, and when Back returns to it.
		await browser.click(`.sidebar-group${withAttribute("data-key", homeKey)} a.session-main[href="/s/${first.id}"]`);
		await browser.wait(`${SELECTED}.join()===${JSON.stringify(homeKey)}`);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${first.id}`);
		await browser.wait(`${SELECTED}.join()===${JSON.stringify(homeKey)}`);
		await browser.click(`.sidebar-section[data-key=recent] a.session-main[href="/s/${second.id}"]`);
		await browser.wait(`location.pathname==='/s/${second.id}' && ${SELECTED}.join()==='recent'`);
		await browser.evaluate("history.back()");
		await browser.wait(`location.pathname==='/s/${first.id}' && ${SELECTED}.join()===${JSON.stringify(homeKey)}`);
	});

	it("collapses rollups and groups, and sets a rollup's window and place from its options", async () => {
		const home = folder("home");
		await create("Kept", home);
		const homeKey = folderKey(null, home);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`document.querySelector('.sidebar-section[data-key=recent] .session-main')`);
		// A rollup collapses to its row, the choice is kept on the server; so does a group.
		await browser.click(".sidebar-section[data-key=recent] .section-toggle");
		await until(settings.collapsed, (collapsed) => collapsed?.recent === true);
		await browser.wait(`document.querySelector('.sidebar-section[data-key=recent] > ul').hidden`);
		const group = `.sidebar-group${withAttribute("data-key", homeKey)}`;
		// A group's row shows or hides its sessions.
		await browser.click(`${group} .group-link`);
		await until(settings.collapsed, (collapsed) => collapsed?.[homeKey] === true);
		await browser.wait(`!document.querySelector(${JSON.stringify(`${group} .session-main`)})`);
		// The rollup's options: its window, and its place among the rollups.
		await browser.click('.sidebar-section[data-key=folders] button[aria-label="Folders options"]');
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Folders]')`);
		await browser.evaluate(clickInSheet("1 week"));
		await until(settings.windows, (windows) => windows?.folders === "1w");
		await browser.evaluate(clickInSheet("Move up"));
		await until(settings.order, (order) => order?.[1] === "folders");
		await browser.wait(`document.querySelectorAll('.sidebar-section')[1]?.dataset.key==='folders'`);
		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('[role=dialog]')`);
	});

	it("starts a session from a folder's + in that folder", async () => {
		const target = folder("target");
		await create("In target", target);
		// The newest session is elsewhere: the new-session screen would start there without the "+".
		await create("Newest", folder("elsewhere"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.click(`.sidebar-group${withAttribute("data-key", folderKey(null, target))} .group-new`);
		await browser.wait(`!document.querySelector('.offline') && document.body.textContent.includes('Faux Model')`);
		await browser.evaluate(setInput(".composer textarea", "Folder start"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(`location.pathname.startsWith('/s/')`);
		const rows = await until(sessions.sessions, (list) => list?.some((row) => row.title.startsWith("Folder start")));
		assert.equal(rows?.find((row) => row.title.startsWith("Folder start"))?.cwd, target);
	});

	it("starts a session from a project's + at its place, in the project, and the next new session in none", async () => {
		const place = folder("place");
		await create("Newest", folder("elsewhere"));
		await writeFile(join(fixture.dataDir, "projects.json"), JSON.stringify({ zebra: [{ path: place }] }));
		const projects = await holdIn(fixture.browser(), Projects, {}, "owner");
		await until(projects.projects, (list) => list?.some((project) => project.name === "zebra"));
		// A project without sessions has no group in the sidebar; its "+" is on the Projects list.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/list/projects`);
		await browser.click(`.list-page button[aria-label="New session in zebra"]`);
		await browser.wait(
			`document.querySelector('.cwd-join')?.textContent==='in zebra' && !document.querySelector('.offline') && document.body.textContent.includes('Faux Model')`,
		);
		await browser.evaluate(setInput(".composer textarea", "Project start"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(`location.pathname.startsWith('/s/')`);
		const rows = await until(sessions.sessions, (list) => list?.some((row) => row.title.startsWith("Project start")));
		const created = rows?.find((row) => row.title.startsWith("Project start"));
		assert.equal(created?.cwd, place);
		await until(projects.sessions, (members) => members?.[created!.id] === "zebra");
		await browser.wait(
			`document.querySelector(${JSON.stringify(`.sidebar-group${withAttribute("data-key", projectKey("zebra"))} .session-main`)})`,
		);
		// The next new session joins no project.
		await browser.click(".new-session");
		await browser.wait(`document.querySelector('.composer textarea') && !document.querySelector('.cwd-join')`);
		projects.release();
	});

	it("shows what sessions do: framed or spinning while working, bold with a dot when unread, summed up when hidden", async () => {
		const work = folder("work");
		const runs = await create("Runs", work);
		const looking = await create("Looking", folder("look"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${looking.id}`);
		const inRecents = `[...document.querySelectorAll('.sidebar-section[data-key=recent] .session-row')].find(e=>e.querySelector('.session-title').textContent==='Runs')`;
		const group = `.sidebar-group${withAttribute("data-key", folderKey(null, work))}`;
		await browser.wait(`Boolean(${inRecents})`);
		const chat = await holdIn(fixture.browser(), Chat, { session: runs.id, conversation: 1 }, "participant");
		await chat.send({ text: "slow-tool", requestId: "working" }, BACKGROUND_CONTEXT);
		// Working: a frame around a Recents row's glyph, a spinner on a group's session row (it has no glyph).
		await browser.wait(`Boolean(${inRecents}.querySelector('.nav-icon.working > .working-frame'))`);
		await browser.wait(`Boolean(document.querySelector(${JSON.stringify(`${group} .session-row .working-mark`)}))`);
		// A collapsed group frames its own icon while a session it hides works.
		await settings.setCollapsed({ key: folderKey(null, work), collapsed: true }, BACKGROUND_CONTEXT);
		await browser.wait(`Boolean(document.querySelector(${JSON.stringify(`${group} .group-row .working-frame`)}))`);
		// Done and unread: no motion, a bold title and a dot; the collapsed group and the menu badge count it.
		await browser.wait(
			`Boolean(${inRecents}.querySelector('.unread-dot')) && !${inRecents}.querySelector('.working-frame')`,
		);
		assert.ok(
			await browser.evaluate<boolean>(`${inRecents}.querySelector('.session-title').classList.contains('unread')`),
		);
		await browser.wait(
			`document.querySelector(${JSON.stringify(`${group} .group-row .unread-count`)})?.textContent==='1' && !document.querySelector(${JSON.stringify(`${group} .working-frame`)})`,
		);
		await browser.wait(`document.querySelector('.topbar .sidebar-open .menu-badge')?.textContent==='1'`);
		// A collapsed rollup counts too.
		await settings.setCollapsed({ key: "recent", collapsed: true }, BACKGROUND_CONTEXT);
		await browser.wait(
			`document.querySelector('.sidebar-section[data-key=recent] .rollup-row .unread-count')?.textContent==='1'`,
		);
		// Opening it reads it: the badge goes.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${runs.id}`);
		await browser.wait(`document.querySelector('.topbar .sidebar-open') && !document.querySelector('.menu-badge')`);
		await browser.wait(`!document.querySelector('.sidebar-section[data-key=recent] .unread-count')`);
		chat.release();
	});

	it("shows project glyphs on groups, Recents' sessions and the top bar, a project's on its folders and sessions", async () => {
		const place = folder("glyphed");
		const inside = folder("glyphed/sub");
		const other = folder("other");
		await writeFile(join(fixture.dataDir, "projects.json"), JSON.stringify({ glyphed: [{ path: place }] }));
		const projects = await holdIn(fixture.browser(), Projects, {}, "owner");
		await until(projects.projects, (list) => list?.some((project) => project.name === "glyphed"));
		const member = await create("Member", other);
		await projects.assign({ session: member.id, project: "glyphed" }, BACKGROUND_CONTEXT);
		await create("Inside", inside);
		await create("Other", other);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		const recent = ".sidebar-section[data-key=recent]";
		await browser.wait(`document.querySelectorAll('${recent} .nav-icon > svg.glyph-icon').length===3`);
		// A Recents row: its glyph in the marker column, its path as the row's tooltip.
		assert.deepEqual(
			await browser.evaluate(
				`[...document.querySelectorAll('${recent} .session-main')].map(e=>[e.querySelector('.session-title').textContent,e.title]).sort()`,
			),
			[
				["Inside", inside],
				["Member", other],
				["Other", other],
			],
		);
		const glyph = (selector: string) =>
			browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).innerHTML`);
		const inRecents = (title: string) =>
			browser.evaluate(
				`[...document.querySelectorAll('${recent} .session-row')].find(e=>e.querySelector('.session-title').textContent===${JSON.stringify(title)}).querySelector('.nav-icon svg').innerHTML`,
			);
		const project = await glyph(`.sidebar-group${withAttribute("data-key", projectKey("glyphed"))} .nav-marker svg`);
		// The project, a folder inside its place, a session there and a member elsewhere share the project's glyph.
		assert.equal(
			await glyph(`.sidebar-group${withAttribute("data-key", folderKey(null, inside))} .nav-marker svg`),
			project,
		);
		assert.equal(await inRecents("Inside"), project);
		assert.equal(await inRecents("Member"), project);
		// Any other place has its own.
		const elsewhere = await glyph(
			`.sidebar-group${withAttribute("data-key", folderKey(null, other))} .nav-marker svg`,
		);
		assert.notEqual(elsewhere, project);
		assert.equal(await inRecents("Other"), elsewhere);
		// A group's tooltip: a project's places, a folder's path.
		assert.equal(
			await browser.evaluate(
				`document.querySelector(${JSON.stringify(`.sidebar-group${withAttribute("data-key", projectKey("glyphed"))} .group-link`)}).title`,
			),
			place,
		);
		// An open session's top bar shows its glyph before its path.
		await browser.evaluate(
			`[...document.querySelectorAll('${recent} .session-main')].find(e=>e.querySelector('.session-title').textContent==='Inside').click()`,
		);
		await browser.wait(`document.querySelector('.topbar h1')?.textContent==='Inside'`);
		assert.equal(await glyph(".topbar .title-cwd svg.glyph-icon"), project);
		projects.release();
	});
});
