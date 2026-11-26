// Browser: the sidebar's rollups on Elanor's side navigation: the sessions without a project first, without a heading
// (an "N older" row opening their list when the window hides some), then Projects (a group per project holding the
// sessions the owner put in it, never by folder; its "+" creating a project), then the Archive's link. Lists in the
// main area (aged sessions after the others, dimmed; the list's own search; the Archive's archived projects), collapsing
// rollups and groups, a rollup's window and place, a project group's "+" starting a session in it at its default place,
// a project's commands (its ⋯: rename, default location, order, archive, delete), Move to project…, drag and drop with
// a mouse (a session onto a project or the sessions without one, a project before or after another) and on a touch
// screen (a long press picks a row up; released without moving it opens the row's menu), what a session does
// (working, unread) and its sum on collapsed groups and rollups and the menu button, and an item's action shown on
// hover or keyboard focus in place of its age, its name cut before either. Fake provider, disposable data; every test
// makes its own sessions and projects.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { ProjectCoordinators, Projects } from "../../plugins/projects/contract.ts";
import { SESSIONS_OWNER, Sessions, type SessionsOwner, SidebarSettings } from "../../plugins/sessions/contract.ts";
import { folderKey, projectKey } from "../../plugins/sessions/sidebar/model.ts";
import type { Ref } from "../../src/runtime/chord.ts";
import { Browser, browserTests, COMPOSER, setComposer } from "./browser.ts";
import { type Fixture, holdWith, startFixture, until } from "./helpers.ts";

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

/** The open command menu's chip and its row titles, as expressions. */
const CHIP = `document.querySelector('.command-menu .command-chip')?.textContent`;
const TITLES = `[...document.querySelectorAll('.command-menu [role=option] .command-title')].map((e) => e.textContent)`;
/** The open command menu's row titled `title`, as an expression. */
const option = (title: string) =>
	`[...document.querySelectorAll('.command-menu [role=option]')].find((o) => o.querySelector('.command-title')?.textContent === ${JSON.stringify(title)})`;
/** The middle of the element `expression` evaluates to, as an expression. */
const middle = (expression: string) =>
	`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("sidebar rollups", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let root: string;
	let sessions: SessionsOwner;
	let settings: Ref<typeof SidebarSettings>;
	let projects: Ref<typeof Projects>;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		sessions = await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER);
		settings = await holdWith(owner, SidebarSettings, {});
		projects = await holdWith(owner, Projects, {});
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
		await setProjects({});
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
	/** Replaces every project (live or archived) by these (project name to its one place, in this order). */
	const setProjects = async (places: Record<string, string>) => {
		for (const { name } of [...(projects.projects.value ?? []), ...(projects.archived.value ?? [])])
			await projects.remove({ name }, BACKGROUND_CONTEXT);
		for (const [name, path] of Object.entries(places))
			await projects.create({ name, place: { env: null, path } }, BACKGROUND_CONTEXT);
		const names = Object.keys(places).join();
		await until(projects.projects, (list) => list?.map((project) => project.name).join() === names);
		await until(projects.archived, (list) => list?.length === 0);
	};
	/** A session in `project` (the owner put it there). */
	const createIn = async (title: string, cwd: string, project: string) => {
		const session = await create(title, cwd);
		await projects.assign({ session: session.id, project }, BACKGROUND_CONTEXT);
		return session;
	};
	/** A project's group in the sidebar, as a selector. */
	const groupOf = (name: string) => `.sidebar-group${withAttribute("data-key", projectKey(name))}`;

	it("lists sessions without a project first, without a heading, then projects with theirs, then the Archive", async () => {
		const home = folder("home");
		const place = folder("place");
		await setProjects({ zebra: place });
		const free = await create("Free", home);
		// In the project because the owner put it there; one inside the project's place but never assigned is not.
		const inside = await createIn("Inside", folder("place/sub"), "zebra");
		await create("Unassigned", folder("place/other"));
		const gone = await create("Gone", home);
		await sessions.archive({ id: gone.id }, BACKGROUND_CONTEXT);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${free.id}`);
		await browser.wait(`document.querySelector('.sidebar-group .session-main')`);
		assert.deepEqual(await browser.evaluate(SECTIONS), [
			["other", ["Unassigned", "Free"]],
			["projects", [["zebra", ["Inside"]]]],
			["archive", []],
		]);
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

	it("collapses rollups and groups (an empty one only turns its chevron), and sets a rollup's window and place", async () => {
		const place = folder("place");
		await setProjects({ kept: place, unused: folder("unused") });
		await createIn("Kept", place, "kept");
		const group = groupOf("kept");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`document.querySelector(${JSON.stringify(`${group} .session-main`)})`);
		// A project's chevron shows or hides its sessions; the choice is kept on the server.
		await browser.click(`${group} .group-toggle`);
		await until(settings.collapsed, (collapsed) => collapsed?.[projectKey("kept")] === true);
		await browser.wait(`!document.querySelector(${JSON.stringify(`${group} .session-main`)})`);
		// A project without sessions: its row turns its chevron only, nothing below it takes room.
		const unused = groupOf("unused");
		const height = `Math.round(document.querySelector(${JSON.stringify(unused)}).getBoundingClientRect().height)`;
		const open = await browser.evaluate<number>(height);
		await browser.click(`${unused} .group-toggle`);
		await until(settings.collapsed, (collapsed) => collapsed?.[projectKey("unused")] === true);
		await browser.wait(`document.querySelector(${JSON.stringify(`${unused} .group-toggle`)}).ariaExpanded==='false'`);
		assert.equal(await browser.evaluate<number>(height), open);
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

	it("opens a project's coordinator from its name: made on the first click, the project's row stands for it", async () => {
		const place = folder("coordinated");
		await setProjects({ coordinated: place });
		await createIn("Member", place, "coordinated");
		const group = groupOf("coordinated");
		const titles = `[...document.querySelectorAll(${JSON.stringify(`${group} .session-main .session-title`)})].map(e=>e.textContent).join()`;
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`${titles}==='Member'`);
		await browser.click(`${group} .group-link`);
		const coordinators = await holdWith(fixture.browser(), ProjectCoordinators, {});
		const id = (await until(coordinators.sessions, (map) => map?.coordinated !== undefined)).coordinated!;
		await browser.wait(`location.pathname.startsWith('/s/${id}')`);
		// Selected while it shows, a link to it from now on, and listed nowhere else in the sidebar.
		await browser.wait(
			`document.querySelector(${JSON.stringify(`${group} .group-row`)}).classList.contains('selected') && document.querySelector(${JSON.stringify(`${group} .group-link`)}).getAttribute('href')?.includes(${JSON.stringify(id)})`,
		);
		assert.equal(await browser.evaluate<string>(titles), "Member");
		assert.equal(
			await browser.evaluate<boolean>(`Boolean(document.querySelector('.sidebar-nav [data-session="${id}"]'))`),
			false,
		);
		// Again from elsewhere: the same session.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`${titles}==='Member'`);
		await browser.click(`${group} .group-link`);
		await browser.wait(`location.pathname.startsWith('/s/${id}')`);
		assert.equal(sessions.sessions.value?.filter((row) => row.title === "coordinated coordinator").length, 1);
		coordinators.release();
	});

	it("creates a project from Projects' +: the folder picker, then its name; it shows as a group", async () => {
		const place = folder("fresh");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.click(".sidebar-section[data-key=projects] button.new-project");
		await browser.wait(`document.querySelector('[role=dialog]')?.textContent.includes('Project folder')`);
		await browser.click('button[aria-label="Type a path"]');
		await browser.evaluate(setInput("input[aria-label=Directory]", place));
		await browser.evaluate(`document.querySelector('.location-type').requestSubmit()`);
		await browser.wait(`document.querySelector('.location-use:not(:disabled)')?.textContent.endsWith('/fresh')`);
		await browser.click(".location-use");
		// The folder's name is the first guess.
		await browser.wait(`document.querySelector('[role=dialog] input.input')?.value==='fresh'`);
		await browser.evaluate(clickInSheet("Create"));
		await until(projects.projects, (list) => list?.some((project) => project.name === "fresh"));
		await browser.wait(
			`!document.querySelector('[role=dialog]') && document.querySelector(${JSON.stringify(`.sidebar-group${withAttribute("data-key", projectKey("fresh"))}`)})`,
		);
	});

	it("starts a session from a project group's + at its default place, in the project, and the next new session in none", async () => {
		const place = folder("place");
		await setProjects({ zebra: place });
		// Its newest session works elsewhere: the "+" still starts at the project's default place.
		await createIn("Newest", folder("elsewhere"), "zebra");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.click(`${groupOf("zebra")} .group-new`);
		await browser.wait(
			`document.querySelector('.project-pick span')?.textContent==='zebra' && document.querySelector('.cwd-pick span')?.textContent.endsWith('/place') && !document.querySelector('.offline') && document.body.textContent.includes('Faux Model')`,
		);
		await browser.evaluate(setComposer("Project start"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(`location.pathname.startsWith('/s/')`);
		const rows = await until(sessions.sessions, (list) => list?.some((row) => row.title.startsWith("Project start")));
		const created = rows?.find((row) => row.title.startsWith("Project start"));
		assert.equal(created?.cwd, place);
		await until(projects.sessions, (members) => members?.[created!.id] === "zebra");
		await browser.wait(`document.querySelector(${JSON.stringify(`${groupOf("zebra")} .session-main`)})`);
		// The next new session joins no project.
		await browser.click(".new-session");
		await browser.wait(
			`document.querySelector('${COMPOSER}') && document.querySelector('.project-pick span')?.textContent==='No project'`,
		);
	});

	it("shows what sessions do: pi's dots while working, bold with a dot when unread, summed up when hidden", async () => {
		const place = folder("work");
		await setProjects({ work: place });
		const runs = await createIn("Runs", place, "work");
		const looking = await create("Looking", folder("look"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${looking.id}`);
		const item = itemTitled("Runs");
		const group = groupOf("work");
		await browser.wait(`Boolean(${item})`);
		const chat = await holdWith(fixture.browser(), Chat, { session: runs.id, conversation: 1 }, ...CHAT_PARTICIPANT);
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

	/** Waits for the command menu on `chip`, then taps its row `title`. */
	const choose = async (title: string) => {
		await browser
			.wait(option(title))
			.catch(async () => assert.fail(`no "${title}": ${await browser.evaluate(TITLES)}`));
		await browser.evaluate(`${option(title)}.click()`);
	};
	/** Moves the mouse onto a project's row, then clicks its ⋯, and waits for its menu. */
	const projectMenu = async (name: string) => {
		const row = `document.querySelector(${JSON.stringify(`${groupOf(name)} .group-row`)})`;
		await browser.wait(row);
		await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await browser.evaluate(middle(row))) });
		await browser.click(`${groupOf(name)} button[aria-label=${JSON.stringify(`${name} options`)}]`);
		await browser.wait(`${CHIP}===${JSON.stringify(`Project · ${name}`)}`);
	};
	const shownProjects = `[...document.querySelectorAll('.sidebar-group[data-project]')].map((e) => e.dataset.project).join()`;
	const names = () => projects.projects.value?.map((project) => project.name).join();

	it("opens a project's commands from its ⋯: move up and down, rename, default location, archive, restore, delete", async () => {
		await setProjects({ alpha: folder("alpha"), beta: folder("beta"), gamma: folder("gamma") });
		const one = await createIn("Alpha one", folder("alpha"), "alpha");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`${shownProjects}==='alpha,beta,gamma'`);
		// The ⋯ shows on hover only.
		const options = `document.querySelector(${JSON.stringify(`${groupOf("beta")} .group-options`)})`;
		assert.equal(await browser.evaluate(`getComputedStyle(${options}).opacity`), "0");
		await projectMenu("beta");
		assert.deepEqual(
			(await browser.evaluate<string[]>(TITLES)).filter((title) => /project/i.test(title) || /location/.test(title)),
			[
				"Rename project…",
				"Change default location…",
				"Move project up",
				"Move project down",
				"Archive project",
				"Delete project…",
			],
		);
		await choose("Move project down");
		await until(projects.projects, () => names() === "alpha,gamma,beta");
		await browser.wait(`${shownProjects}==='alpha,gamma,beta'`);
		// The first has no Move up, the last no Move down.
		await projectMenu("alpha");
		await browser.wait(option("Move project down"));
		assert.ok(!(await browser.evaluate<string[]>(TITLES)).includes("Move project up"));
		// Rename: the page's query is the new name; the sessions follow.
		await choose("Rename project…");
		await browser.wait(`document.activeElement?.matches('.command-menu input')`);
		await browser.call("Input.insertText", { text: "omega" });
		await choose("Rename to “omega”");
		await until(projects.sessions, (members) => members?.[one.id] === "omega");
		await browser.wait(
			`${shownProjects}==='omega,gamma,beta' && ${itemTitled("Alpha one")}?.closest('.sidebar-group')?.dataset.project==='omega'`,
		);
		// Change default location…: the picker, then the project's new first place.
		const moved = folder("gamma-moved");
		await projectMenu("gamma");
		await choose("Change default location…");
		await browser.click('button[aria-label="Type a path"]');
		await browser.evaluate(setInput("input[aria-label=Directory]", moved));
		await browser.evaluate(`document.querySelector('.location-type').requestSubmit()`);
		await browser.wait(
			`document.querySelector('.location-use:not(:disabled)')?.textContent.endsWith('/gamma-moved')`,
		);
		await browser.click(".location-use");
		await until(projects.projects, (list) => list?.find((each) => each.name === "gamma")?.places[0]?.path === moved);
		// Archive: the project and its session leave the sidebar for the Archive's list.
		await browser.wait(`!document.querySelector('[role=dialog]')`);
		await projectMenu("omega");
		await choose("Archive project");
		await browser.wait(`${shownProjects}==='gamma,beta' && !${itemTitled("Alpha one")}`);
		await until(sessions.sessions, (rows) => Boolean(rows?.find((row) => row.id === one.id)?.archivedAt));
		await browser.click(".sidebar-section[data-key=archive] .group-label");
		const archived = `document.querySelector('.list-page .archived-project')`;
		await browser.wait(`location.pathname==='/list/archive' && ${archived}?.textContent.includes('omega')`);
		await browser.call("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			...(await browser.evaluate(middle(archived))),
		});
		await browser.click('.list-page button[aria-label="omega options"]');
		await browser.wait(`${CHIP}==='Archived project · omega'`);
		await browser.wait(option("Delete project…"));
		await choose("Restore project");
		// Back after the live projects, with its session.
		await browser.wait(`${shownProjects}==='gamma,beta,omega' && ${itemTitled("Alpha one")}`);
		await browser.wait(`!document.querySelector('.list-page .archived-project')`);
		// Delete: it goes; its session stays, in no project.
		await projectMenu("omega");
		await choose("Delete project…");
		await choose("Delete “omega”");
		await until(projects.projects, () => names() === "gamma,beta");
		await browser.wait(
			`${shownProjects}==='gamma,beta' && ${itemTitled("Alpha one")}?.closest('.sidebar-section')?.dataset.key==='other'`,
		);
		assert.equal(projects.sessions.value?.[one.id], undefined);
	});

	it("drags with a mouse: a session onto a project or the sessions without one, a project before or after another", async () => {
		await setProjects({ alpha: folder("alpha"), beta: folder("beta") });
		const stay = await create("Stay", folder("free"));
		const loose = await create("Loose", folder("free"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${stay.id}`);
		await browser.wait(`${shownProjects}==='alpha,beta' && ${itemTitled("Loose")}`);
		/** Drags from the middle of `from` to `to` (or to a point of its row), checking the drop mark before letting go. */
		const drag = async (from: string, to: string, mark: string, at: "middle" | "top" | "bottom" = "middle") => {
			const start = await browser.evaluate<{ x: number; y: number }>(middle(from));
			const box = await browser.evaluate<{ x: number; top: number; bottom: number }>(
				`(() => { const r = (${to}).getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom }; })()`,
			);
			const y = at === "top" ? box.top + 4 : at === "bottom" ? box.bottom - 4 : (box.top + box.bottom) / 2;
			await browser.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
			await browser.call("Input.dispatchMouseEvent", {
				type: "mousePressed",
				...start,
				button: "left",
				clickCount: 1,
			});
			for (let step = 1; step <= 8; step++)
				await browser.call("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: start.x + ((box.x - start.x) * step) / 8,
					y: start.y + ((y - start.y) * step) / 8,
					button: "left",
					buttons: 1,
				});
			await browser.wait(
				`document.querySelector('.sidebar-drag-ghost') && document.querySelector(${JSON.stringify(mark)})`,
			);
			await browser.call("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: box.x,
				y,
				button: "left",
				clickCount: 1,
			});
			await browser.wait(
				`!document.querySelector('.sidebar-drag-ghost') && !document.querySelector('.drop-into, .drop-before, .drop-after')`,
			);
		};
		const header = (title: string) => `${itemTitled(title)}.querySelector('.session-header')`;
		const groupRow = (name: string) => `document.querySelector(${JSON.stringify(`${groupOf(name)} .group-row`)})`;
		// A session onto a project's group joins it; the drop opens nothing.
		await drag(header("Loose"), groupRow("beta"), `${groupOf("beta")}.drop-into`);
		await until(projects.sessions, (members) => members?.[loose.id] === "beta");
		await browser.wait(`${itemTitled("Loose")}?.closest('.sidebar-group')?.dataset.project==='beta'`);
		assert.equal(await browser.evaluate("location.pathname"), `/s/${stay.id}`);
		// Onto the sessions without a project: it leaves the project.
		await drag(header("Loose"), header("Stay"), ".sidebar-section.headless.drop-into");
		await until(projects.sessions, (members) => members?.[loose.id] === undefined);
		await browser.wait(`${itemTitled("Loose")}?.closest('.sidebar-section')?.dataset.key==='other'`);
		// A project onto another's upper half goes before it, onto its lower half after it.
		await drag(groupRow("beta"), groupRow("alpha"), `${groupOf("alpha")}.drop-before`, "top");
		await until(projects.projects, () => names() === "beta,alpha");
		await browser.wait(`${shownProjects}==='beta,alpha'`);
		await drag(groupRow("beta"), groupRow("alpha"), `${groupOf("alpha")}.drop-after`, "bottom");
		await until(projects.projects, () => names() === "alpha,beta");
		await browser.wait(`${shownProjects}==='alpha,beta'`);
		// A click without a drag still opens the session.
		await browser.click(`.sidebar-nav .session-row[data-session="${loose.id}"] a.session-main`);
		await browser.wait(`location.pathname==='/s/${loose.id}'`);
	});

	it("on a touch screen a long press picks a row up: released it opens the menu (Move to project…), moved it drags", async () => {
		await setProjects({ alpha: folder("alpha"), beta: folder("beta") });
		const free = await create("Touch me", folder("free"));
		await browser.metrics(390, 844);
		await browser.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		const touch = (type: string, point?: { x: number; y: number }) =>
			browser.call("Input.dispatchTouchEvent", { type, touchPoints: point ? [point] : [] });
		const title = `${itemTitled("Touch me")}.querySelector('.session-title')`;
		/** Waits until the drawer stopped moving (pi's dots run forever). */
		const still = () =>
			browser.wait(
				`!document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)`,
			);
		/** Opens the drawer on the session's page. */
		const drawer = async () => {
			await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
			await browser.click(".topbar button[aria-label=Sessions]");
			await browser.wait(`document.querySelector('.app.drawer-open') && ${itemTitled("Touch me")}`);
			await still();
		};
		try {
			await drawer();
			// Held without moving, then released: the session's menu, on release.
			const point = await browser.evaluate<{ x: number; y: number }>(middle(title));
			await touch("touchStart", point);
			await pause(700);
			assert.equal(await browser.evaluate(`Boolean(document.querySelector('.command-menu'))`), false);
			await touch("touchEnd");
			await browser.wait(`${CHIP}==='Session · Touch me'`);
			assert.equal(await browser.evaluate("location.pathname"), "/new", "the long press opens no session");
			await choose("Move to project…");
			// No project (checked), then the projects with their default places.
			await browser.wait(option("beta"));
			assert.deepEqual(await browser.evaluate(TITLES), ["No project", "alpha", "beta"]);
			assert.equal(await browser.evaluate(`${option("No project")}.getAttribute('aria-checked')`), "true");
			await choose("beta");
			await until(projects.sessions, (members) => members?.[free.id] === "beta");
			await browser.wait(
				`!document.querySelector('.command-menu') && ${itemTitled("Touch me")}?.closest('.sidebar-group')?.dataset.project==='beta'`,
			);
			// Held, then moved onto alpha's group: a drag, with the ghost; the list does not scroll meanwhile.
			await still();
			const from = await browser.evaluate<{ x: number; y: number }>(middle(title));
			const to = await browser.evaluate<{ x: number; y: number }>(
				middle(`document.querySelector(${JSON.stringify(`${groupOf("alpha")} .group-row`)})`),
			);
			await touch("touchStart", from);
			await pause(700);
			for (let step = 1; step <= 10; step++) {
				await touch("touchMove", {
					x: from.x + ((to.x - from.x) * step) / 10,
					y: from.y + ((to.y - from.y) * step) / 10,
				});
				await pause(16);
			}
			await browser.wait(
				`document.querySelector('.sidebar-drag-ghost')?.textContent==='Touch me' && document.querySelector(${JSON.stringify(`${groupOf("alpha")}.drop-into`)})`,
			);
			await touch("touchEnd");
			await until(projects.sessions, (members) => members?.[free.id] === "alpha");
			await browser.wait(
				`!document.querySelector('.sidebar-drag-ghost') && ${itemTitled("Touch me")}?.closest('.sidebar-group')?.dataset.project==='alpha'`,
			);
			assert.equal(await browser.evaluate(`Boolean(document.querySelector('.command-menu'))`), false);
			assert.equal(await browser.evaluate("location.pathname"), "/new");
			// A project's row: released without moving, its menu.
			await still();
			const project = await browser.evaluate<{ x: number; y: number }>(
				middle(`document.querySelector(${JSON.stringify(`${groupOf("beta")} .group-row .session-title`)})`),
			);
			await touch("touchStart", project);
			await pause(700);
			await touch("touchEnd");
			await browser.wait(`${CHIP}==='Project · beta'`);
			await browser.wait(option("Archive project"));
			// A quick tap still opens the session.
			await browser.evaluate("history.back()");
			await browser.wait(`!document.querySelector('.command-menu')`);
		} finally {
			await browser.call("Emulation.setTouchEmulationEnabled", { enabled: false });
		}
	});

	it("chooses the new session's project on the new-session screen: it starts at its default place and joins it", async () => {
		const place = folder("beta");
		await setProjects({ alpha: folder("alpha"), beta: place });
		await create("Elsewhere", folder("elsewhere"));
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(
			`document.querySelector('.project-pick span')?.textContent==='No project' && !document.querySelector('.offline') && document.body.textContent.includes('Faux Model')`,
		);
		const start = await browser.evaluate<string>(`document.querySelector('.cwd-pick span').textContent`);
		// Above the location control.
		assert.ok(
			await browser.evaluate<boolean>(
				`document.querySelector('.project-pick').getBoundingClientRect().bottom <= document.querySelector('.cwd-pick').getBoundingClientRect().top`,
			),
		);
		await browser.click(".project-pick");
		await browser.wait(`document.querySelector('.command-menu .command-crumb')?.textContent==='Project'`);
		await browser.wait(option("beta"));
		assert.deepEqual(await browser.evaluate(TITLES), ["No project", "alpha", "beta"]);
		await choose("beta");
		await browser.wait(
			`!document.querySelector('.command-menu') && document.querySelector('.project-pick span')?.textContent==='beta' && document.querySelector('.cwd-pick span')?.textContent.endsWith('/beta')`,
		);
		// No project again: the location stays where the project put it.
		await browser.click(".project-pick");
		await choose("No project");
		await browser.wait(`document.querySelector('.project-pick span')?.textContent==='No project'`);
		assert.notEqual(start, await browser.evaluate<string>(`document.querySelector('.cwd-pick span').textContent`));
		await browser.click(".project-pick");
		await choose("beta");
		await browser.wait(`document.querySelector('.project-pick span')?.textContent==='beta'`);
		await browser.evaluate(setComposer("Picked project"));
		await browser.click("button[aria-label=Send]");
		await browser.wait(`location.pathname.startsWith('/s/')`);
		const rows = await until(sessions.sessions, (list) =>
			list?.some((row) => row.title.startsWith("Picked project")),
		);
		const created = rows?.find((row) => row.title.startsWith("Picked project"));
		assert.equal(created?.cwd, place);
		await until(projects.sessions, (members) => members?.[created!.id] === "beta");
		await browser.wait(`${itemTitled(created!.title)}?.closest('.sidebar-group')?.dataset.project==='beta'`);
	});
});
