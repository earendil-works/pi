// Browser: the sidebar's rollups on Elanor's side navigation: the sessions without a project first, without a heading
// (an "N older" row opening their list when the window hides some), then Projects (a group per project holding the
// sessions that joined it or work inside its place; its "+" creating a project), then the Archive's link. Lists in the
// main area (aged sessions after the others, dimmed; the list's own search), collapsing rollups and groups, a rollup's
// window and place, a project group's "+" starting a session in it, what a session does (working, unread) and its sum
// on collapsed groups and rollups and the menu button, and an item's action shown on hover or keyboard focus in place of
// its age, its name cut before either. Fake provider, disposable data; every test makes its own sessions.
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
import { Browser, browserTests, COMPOSER, setComposer } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** Each rollup's key, then its sessions' titles, or its groups' names with their sessions' titles. */
const SECTIONS = `[...document.querySelectorAll('.sidebar-section')].map(s=>[s.dataset.key,s.querySelector('.sidebar-group')?[...s.querySelectorAll('.sidebar-group')].map(g=>[g.querySelector('.group-link').textContent,[...g.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)]):[...s.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)])`;

/** The main area's list: its group labels and titles, an aged one marked. */
const PAGE = `[...document.querySelectorAll('.list-page .list-group-link, .list-page .session-row')].map(e=>e.classList.contains('session-row')?e.querySelector('.session-main .session-title').textContent+(e.classList.contains('aged')?' aged':''):'# '+e.textContent)`;

/** Clicks the button of the open sheet whose text is `text`. */
const clickInSheet = (text: string) =>
	`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`;

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;

/** A selector for the element with `attribute` equal to `value`, quoted for any value. */
const withAttribute = (attribute: string, value: string) => `[${attribute}=${JSON.stringify(value)}]`;

/** The sidebar's session item titled `title` (its `.session-row`). */
const itemTitled = (title: string) =>
	`[...document.querySelectorAll('.sidebar-nav .session-row')].find(e=>e.querySelector('.session-title').textContent===${JSON.stringify(title)})`;

describe("sidebar rollups", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let root: string;
	let sessions: Awaited<ReturnType<typeof holdIn<typeof Sessions, "owner">>>;
	let settings: Awaited<ReturnType<typeof holdIn<typeof SidebarSettings, "owner">>>;
	let projects: Awaited<ReturnType<typeof holdIn<typeof Projects, "owner">>>;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		sessions = await holdIn(owner, Sessions, {}, "owner");
		settings = await holdIn(owner, SidebarSettings, {}, "owner");
		projects = await holdIn(owner, Projects, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});
	// Each test sees only its own sessions and projects, in folders of its own, with the default settings.
	beforeEach(async (context) => {
		for (const row of sessions.sessions.value ?? [])
			if (!row.archivedAt) await sessions.archive({ id: row.id }, BACKGROUND_CONTEXT);
		await writeProjects({});
		for (const key of ["other", "projects", "archive"]) {
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
	/** Writes projects.json (project name to its places) and waits until the server read it. */
	const writeProjects = async (places: Record<string, string>) => {
		await writeFile(
			join(fixture.dataDir, "projects.json"),
			JSON.stringify(Object.fromEntries(Object.entries(places).map(([name, path]) => [name, [{ path }]]))),
		);
		const names = Object.keys(places).join();
		await until(projects.projects, (list) => list?.map((project) => project.name).join() === names);
	};

	it("lists sessions without a project first, without a heading, then projects with theirs, then the Archive", async () => {
		const home = folder("home");
		const place = folder("place");
		await writeProjects({ zebra: place });
		const free = await create("Free", home);
		// Inside the project's place, never assigned: it shows under the project without joining it.
		const inside = await create("Inside", folder("place/sub"));
		const gone = await create("Gone", home);
		await sessions.archive({ id: gone.id }, BACKGROUND_CONTEXT);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${free.id}`);
		await browser.wait(`document.querySelector('.sidebar-group .session-main')`);
		assert.deepEqual(await browser.evaluate(SECTIONS), [
			["other", ["Free"]],
			["projects", [["zebra", ["Inside"]]]],
			["archive", []],
		]);
		assert.equal(projects.sessions.value?.[inside.id], undefined);
		assert.equal(
			await browser.evaluate(`document.querySelector('.sidebar-section[data-key=other]').matches('.headless')`),
			true,
		);
		assert.equal(
			await browser.evaluate(`document.querySelector('.sidebar-section[data-key=other] .group-label')`),
			null,
		);
		assert.match(
			await browser.evaluate<string>(
				`document.querySelector('.sidebar-section[data-key=archive] .section-count').textContent`,
			),
			/^\d+$/,
		);
		// Rows are links: the browser opens one in another tab on a modified click.
		assert.equal(
			await browser.evaluate<string>(`${itemTitled("Inside")}.querySelector('a.session-main').getAttribute('href')`),
			`/s/${inside.id}`,
		);
		// A click anywhere in a row opens it: here between the title and the age.
		const blank = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const row = ${itemTitled("Inside")}.querySelector('.nav-row'), title = row.querySelector('.session-title').getBoundingClientRect(), age = row.querySelector('.item-age').getBoundingClientRect(); return { x: (title.right + age.left) / 2, y: title.top + title.height / 2 }; })()`,
		);
		await browser.clickPoint(blank.x, blank.y);
		await browser.wait(`location.pathname==='/s/${inside.id}'`);
		// Projects' name lists every project with its sessions.
		await browser.click(".sidebar-section[data-key=projects] .group-label");
		await browser.wait(`location.pathname==='/list/projects' && document.querySelector('.list-page .session-row')`);
		assert.deepEqual(await browser.evaluate(PAGE), ["# zebra", "Inside"]);
		// The Archive's list holds the archived session.
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

	it("hides aged sessions behind an 'N older' row that opens the list, where they come last, dimmed", async () => {
		const pinned = await create("Pinned old", folder("old"));
		await sessions.pin({ id: pinned.id, pinned: true }, BACKGROUND_CONTEXT);
		await create("Plain old", folder("old"));
		// The page's clock four days ahead: both sessions are older than the window's three days; the pinned one stays.
		const { identifier } = (await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `{const now=Date.now;Date.now=()=>now()+${4 * 24 * 60 * 60 * 1000};}`,
		})) as { identifier: string };
		try {
			await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
			const older = ".sidebar-section[data-key=other] .older-row";
			await browser.wait(`document.querySelector('${older}')?.textContent==='1 older'`);
			assert.deepEqual((await browser.evaluate<[string, string[]][]>(SECTIONS))[0], ["other", ["Pinned old"]]);
			await browser.click(`${older} .nav-link`);
			await browser.wait(
				`location.pathname==='/list/other' && document.querySelectorAll('.list-page .session-row').length===2`,
			);
			assert.deepEqual(await browser.evaluate(PAGE), ["Pinned old", "Plain old aged"]);
			// Dimmed: the aged row's title is another colour than the relevant one's.
			const color = (selector: string) =>
				browser.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color`);
			assert.notEqual(
				await color(".list-page .session-row.aged .session-title"),
				await color(".list-page .session-row:not(.aged) .session-title"),
			);
			// Forever keeps every session in view: no older row.
			await settings.setWindow({ key: "other", window: "forever" }, BACKGROUND_CONTEXT);
			await browser.wait(
				`!document.querySelector('.list-page .aged') && !document.querySelector('${older}') && document.querySelectorAll('.sidebar-section[data-key=other] .session-main').length===2`,
			);
		} finally {
			await browser.call("Page.removeScriptToEvaluateOnNewDocument", { identifier });
		}
	});

	it("collapses rollups and groups, and sets a rollup's window and place from its options", async () => {
		const place = folder("place");
		await writeProjects({ kept: place });
		await create("Kept", place);
		const group = `.sidebar-group${withAttribute("data-key", projectKey("kept"))}`;
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`document.querySelector(${JSON.stringify(`${group} .session-main`)})`);
		// A group's row shows or hides its sessions; the choice is kept on the server.
		await browser.click(`${group} .group-link`);
		await until(settings.collapsed, (collapsed) => collapsed?.[projectKey("kept")] === true);
		await browser.wait(`!document.querySelector(${JSON.stringify(`${group} .session-main`)})`);
		// A rollup collapses to its row; so is that kept.
		await browser.click(".sidebar-section[data-key=projects] .section-toggle");
		await until(settings.collapsed, (collapsed) => collapsed?.projects === true);
		await browser.wait(`document.querySelector('.sidebar-section[data-key=projects] > ul').hidden`);
		// The rollup's options: its window, and its place among the rollups with a heading.
		await browser.click('.sidebar-section[data-key=projects] button[aria-label="Projects options"]');
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Projects]')`);
		await browser.evaluate(clickInSheet("1 week"));
		await until(settings.windows, (windows) => windows?.projects === "1w");
		await browser.evaluate(clickInSheet("Move down"));
		await until(settings.order, (order) => order?.[1] === "projects");
		// The sessions without a project stay first.
		await browser.wait(
			`[...document.querySelectorAll('.sidebar-section')].map(e=>e.dataset.key).join()==='other,archive,projects'`,
		);
		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('[role=dialog]')`);
	});

	it("creates a project from Projects' +: the folder picker, then its name; it shows as a group", async () => {
		const place = folder("fresh");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.click(".sidebar-section[data-key=projects] button.new-project");
		await browser.wait(`document.querySelector('[role=dialog]')?.textContent.includes('Project folder')`);
		await browser.evaluate(setInput(".directory-head input.mono", place));
		await browser.evaluate(`document.querySelector('.directory-head form').requestSubmit()`);
		await browser.wait(`document.querySelector('.directory-use')?.textContent.endsWith('/fresh')`);
		await browser.click(".directory-use");
		// The folder's name is the first guess.
		await browser.wait(`document.querySelector('[role=dialog] input.input')?.value==='fresh'`);
		await browser.evaluate(clickInSheet("Create"));
		await until(projects.projects, (list) => list?.some((project) => project.name === "fresh"));
		await browser.wait(
			`!document.querySelector('[role=dialog]') && document.querySelector(${JSON.stringify(`.sidebar-group${withAttribute("data-key", projectKey("fresh"))}`)})`,
		);
	});

	it("starts a session from a project group's + at its place, in the project, and the next new session in none", async () => {
		const place = folder("place");
		await create("Newest", folder("elsewhere"));
		await writeProjects({ zebra: place });
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		// A project without sessions has its group, with its "+".
		await browser.click(`.sidebar-group${withAttribute("data-key", projectKey("zebra"))} .group-new`);
		await browser.wait(
			`document.querySelector('.cwd-join')?.textContent==='in zebra' && !document.querySelector('.offline') && document.body.textContent.includes('Faux Model')`,
		);
		await browser.evaluate(setComposer("Project start"));
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
		await browser.wait(`document.querySelector('${COMPOSER}') && !document.querySelector('.cwd-join')`);
	});

	it("shows what sessions do: pi's dots while working, bold with a dot when unread, summed up when hidden", async () => {
		const place = folder("work");
		await writeProjects({ work: place });
		const runs = await create("Runs", place);
		const looking = await create("Looking", folder("look"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${looking.id}`);
		const item = itemTitled("Runs");
		const group = `.sidebar-group${withAttribute("data-key", projectKey("work"))}`;
		await browser.wait(`Boolean(${item})`);
		const chat = await holdIn(fixture.browser(), Chat, { session: runs.id, conversation: 1 }, "participant");
		await chat.send({ text: "slow-tool", requestId: "working" }, BACKGROUND_CONTEXT);
		// Working: pi's dots in the status column, named "Working".
		await browser.wait(`Boolean(${item}.querySelector('.nav-marker .pi-dots'))`);
		assert.deepEqual(
			await browser.evaluate(
				`(e=>[e.getAttribute('role'),e.getAttribute('aria-label')])(${item}.querySelector('.pi-dots'))`,
			),
			["img", "Working"],
		);
		// A collapsed group counts its working sessions.
		await settings.setCollapsed({ key: projectKey("work"), collapsed: true }, BACKGROUND_CONTEXT);
		await browser.wait(`Boolean(document.querySelector(${JSON.stringify(`${group} .group-row .working-count`)}))`);
		// Done and unread: the collapsed group and the menu badge count it.
		await browser.wait(
			`document.querySelector(${JSON.stringify(`${group} .group-row .unread-count`)})?.textContent==='1' && !document.querySelector(${JSON.stringify(`${group} .working-count`)})`,
		);
		await browser.wait(`document.querySelector('.topbar .sidebar-open .menu-badge')?.textContent==='1'`);
		// A collapsed rollup counts too.
		await settings.setCollapsed({ key: "projects", collapsed: true }, BACKGROUND_CONTEXT);
		await browser.wait(
			`document.querySelector('.sidebar-section[data-key=projects] .rollup-row .unread-count')?.textContent==='1'`,
		);
		// Shown: a dot instead of the dots, and a bold title.
		await settings.setCollapsed({ key: "projects", collapsed: false }, BACKGROUND_CONTEXT);
		await settings.setCollapsed({ key: projectKey("work"), collapsed: false }, BACKGROUND_CONTEXT);
		await browser.wait(`Boolean(${item}?.querySelector('.nav-marker .unread-dot'))`);
		assert.equal(await browser.evaluate(`Boolean(${item}.querySelector('.pi-dots'))`), false);
		assert.ok(
			await browser.evaluate<boolean>(`${item}.querySelector('.session-title').classList.contains('unread')`),
		);
		// Opening it reads it: the badge goes.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${runs.id}`);
		await browser.wait(`document.querySelector('.topbar .sidebar-open') && !document.querySelector('.menu-badge')`);
		await browser.wait(`${item} && !${item}.querySelector('.unread-dot')`);
		chat.release();
	});

	it("shows an item's action in place of its age on hover and keyboard focus, its long name cut before them", async () => {
		const title = `Long ${"name ".repeat(15)}end`;
		const other = await create("Other", folder("other"));
		const long = await create(title, folder("long"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${other.id}`);
		const row = `${itemTitled(title)}?.querySelector('.nav-row')`;
		await browser.wait(`Boolean(${row})`);
		/** The row's name, age and action boxes (left to right), whether the name is cut, and what shows. */
		const layout = () =>
			browser.evaluate<{ cut: boolean; gap: number; action: string; age: string }>(
				`(() => { const r = ${row}, t = r.querySelector('.nav-label'), a = r.querySelector('.item-action'), d = r.querySelector('.nav-details'); return { cut: t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === 'ellipsis', gap: Math.min(d.getBoundingClientRect().left, a.getBoundingClientRect().left) - t.getBoundingClientRect().right, action: getComputedStyle(a).opacity + ' ' + getComputedStyle(a).pointerEvents, age: getComputedStyle(d).visibility }; })()`,
			);
		// At rest: the age shows, the action is laid out but invisible and not hit; the name ends before both.
		const rest = await layout();
		assert.equal(rest.cut, true);
		assert(rest.gap >= 0, `the name overlaps the age or the action by ${-rest.gap}px`);
		assert.deepEqual([rest.action, rest.age], ["0 none", "visible"]);
		// Keyboard: Tab from the name reaches the action, which shows instead of the age.
		await browser.evaluate(`${row}.querySelector('a.session-main').focus()`);
		await browser.call("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			key: "Tab",
			code: "Tab",
			windowsVirtualKeyCode: 9,
		});
		await browser.call("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Tab",
			code: "Tab",
			windowsVirtualKeyCode: 9,
		});
		assert.equal(await browser.evaluate(`document.activeElement.getAttribute('aria-label')`), `Archive ${title}`);
		assert.deepEqual(await layout().then(({ action, age }) => [action, age]), ["1 auto", "hidden"]);
		await browser.evaluate(`document.activeElement.blur()`);
		// Hover: the same; a click on it archives the session, gone from the sidebar at once.
		const point = await browser.evaluate<{ x: number; y: number }>(
			`(() => { const b = ${row}.querySelector('.item-action').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
		);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
		assert.deepEqual(await layout().then(({ action, age }) => [action, age]), ["1 auto", "hidden"]);
		await browser.clickPoint(point.x, point.y);
		await browser.wait(`!${itemTitled(title)}`);
		await until(sessions.sessions, (list) => Boolean(list?.find((each) => each.id === long.id)?.archivedAt));
	});
});
