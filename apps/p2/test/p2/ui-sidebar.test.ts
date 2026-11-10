// Browser: the sidebar's rollups on Elanor's side navigation (Recents, projects, folders, the Archive), groups shown
// only with relevant sessions, a rollup's or a group's name opening its list in the main area (aged sessions after the
// others, dimmed; the list's search), collapsing a rollup, a rollup's window and place, and a folder's "+" starting a
// session in it. Fake provider, disposable data.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Models } from "../../plugins/models/contract.ts";
import { Projects } from "../../plugins/projects/contract.ts";
import { Sessions, SidebarSettings } from "../../plugins/sessions/contract.ts";
import { folderKey } from "../../plugins/sessions/sidebar/model.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** Each rollup's key, then its sessions' titles, or its groups' names with their sessions' titles. */
const SECTIONS = `[...document.querySelectorAll('.sidebar-section')].map(s=>[s.dataset.key,s.querySelector('.sidebar-group')?[...s.querySelectorAll('.sidebar-group')].map(g=>[g.querySelector('.group-link').textContent,[...g.querySelectorAll('.session-title')].map(e=>e.textContent)]):[...s.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)])`;

/** The main area's list: its group labels and titles, an aged one marked. */
const PAGE = `[...document.querySelectorAll('.list-page .list-group-label, .list-page .session-row')].map(e=>e.classList.contains('list-group-label')?'# '+e.textContent:e.querySelector('.session-title').textContent+(e.classList.contains('aged')?' aged':''))`;

/** Clicks the button of the open sheet whose text is `text`. */
const clickInSheet = (text: string) =>
	`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`;

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;

describe("sidebar rollups", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	before(async () => {
		fixture = await startFixture({ web: true });
		await fixture
			.browser()
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("shows Recents flat, projects and folders as groups, the Archive as a link; names open lists", async () => {
		const owner = fixture.browser();
		const project = join(fixture.workspace, "pi");
		mkdirSync(project);
		await writeFile(join(fixture.dataDir, "projects.json"), JSON.stringify({ pi: [{ path: project }] }));
		const projects = await holdIn(owner, Projects, {}, "owner");
		await until(projects.projects, (list) => list?.length === 1);
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const free = await sessions.create({ cwd: fixture.workspace, title: "Free" }, BACKGROUND_CONTEXT);
		const inPi = await sessions.create({ cwd: project, title: "In pi" }, BACKGROUND_CONTEXT);
		const gone = await sessions.create({ cwd: fixture.workspace, title: "Gone" }, BACKGROUND_CONTEXT);
		await sessions.archive({ id: gone.id }, BACKGROUND_CONTEXT);
		await projects.assign({ session: inPi.id, project: "pi" }, BACKGROUND_CONTEXT);
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${free.id}`);
		await browser.wait(`document.querySelector('.sidebar-section[data-key=projects] .session-main')`);
		assert.deepEqual(await browser.evaluate(SECTIONS), [
			["recent", ["In pi", "Free"]],
			["projects", [["pi", ["In pi"]]]],
			[
				"folders",
				[
					["pi", ["In pi"]],
					["workspace", ["Free"]],
				],
			],
			["archive", []],
		]);
		// Rows are links: the browser opens one in another tab on a modified click.
		assert.equal(
			await browser.evaluate<string>(
				`document.querySelector('.sidebar-section[data-key=projects] a.session-main').getAttribute('href')`,
			),
			`/s/${inPi.id}`,
		);

		// Recents' name opens every session in the main area; a row opens its session; Back returns.
		await browser.click(".sidebar-section[data-key=recent] .group-label");
		await browser.wait(
			`location.pathname==='/list/recent' && document.querySelectorAll('.list-page .session-row').length===2`,
		);
		assert.deepEqual(await browser.evaluate(PAGE), ["In pi", "Free"]);
		await browser.click(".list-page a.session-main");
		await browser.wait(`location.pathname==='/s/${inPi.id}'`);
		await browser.evaluate("history.back()");
		await browser.wait(`location.pathname==='/list/recent' && document.querySelector('.list-page')`);
		// Folders' name lists every folder with its sessions; a folder's name lists its own.
		await browser.click(".sidebar-section[data-key=folders] .group-label");
		await browser.wait(
			`location.pathname==='/list/folders' && document.querySelectorAll('.list-page .session-row').length===2`,
		);
		assert.deepEqual(await browser.evaluate(PAGE), ["# pi", "In pi", "# workspace", "Free"]);
		const home = folderKey(null, fixture.workspace);
		await browser.click(`.sidebar-group[data-key=${JSON.stringify(home)}] .group-link`);
		await browser.wait(`document.querySelector('.list-page h1')?.textContent==='workspace'`);
		assert.deepEqual(await browser.evaluate(PAGE), ["Free"]);
		// The Archive's list holds the archived session.
		await browser.click(".sidebar-section[data-key=archive] .group-label");
		await browser.wait(
			`location.pathname==='/list/archive' && document.querySelectorAll('.list-page .session-row').length===1`,
		);
		assert.deepEqual(await browser.evaluate(PAGE), ["Gone"]);
		// The list's search finds within the list.
		await browser.click(".sidebar-section[data-key=recent] .group-label");
		await browser.wait(`location.pathname==='/list/recent' && document.querySelector('.list-page input')`);
		await browser.evaluate(setInput(".list-page input", "Free"));
		await browser.wait(`document.querySelectorAll('.list-page .session-row').length===1`);
		assert.deepEqual(await browser.evaluate(PAGE), ["Free"]);
	});

	it("selects an open session in one place: where it was opened from, else the first place it shows", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const free = sessions.sessions.value?.find((row) => row.title === "Free");
		assert(free);
		const selected = `[...document.querySelectorAll('.sidebar-nav a.session-main[data-active]')].map(e=>e.closest('[data-key]').dataset.key)`;
		const home = folderKey(null, fixture.workspace);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${free.id}`);
		await browser.wait(`document.querySelector('.sidebar-nav a.session-main[data-active]')`);
		assert.deepEqual(await browser.evaluate(selected), ["recent"]);
		// Opened from its folder: selected there only, also after a reload.
		await browser.click(`.sidebar-group[data-key=${JSON.stringify(home)}] a.session-main`);
		await browser.wait(`${selected}.join()===${JSON.stringify(home)}`);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${free.id}`);
		await browser.wait(`${selected}.join()===${JSON.stringify(home)}`);
	});

	it("puts the aged sessions after the others in a list, dimmed, and keeps them and their groups out of the sidebar", async () => {
		// The page's clock four days ahead: every session is older than the rollups' three days.
		await browser.call("Page.addScriptToEvaluateOnNewDocument", {
			source: `{const now=Date.now;Date.now=()=>now()+${4 * 24 * 60 * 60 * 1000};}`,
		});
		await browser.open(`http://127.0.0.1:${fixture.server.port}/list/folders`);
		await browser.wait(`document.querySelectorAll('.list-page .session-row').length===2`);
		assert.deepEqual(await browser.evaluate(PAGE), ["# pi", "In pi aged", "# workspace", "Free aged"]);
		// Dimmed: the secondary colour, as the page's subtitle.
		assert(
			await browser.evaluate<boolean>(
				`getComputedStyle(document.querySelector('.list-page .aged .session-title')).color===getComputedStyle(document.querySelector('.list-page .title p')).color`,
			),
		);
		// No relevant session: Recents is empty, and the groups are gone from the sidebar.
		assert.deepEqual(await browser.evaluate(SECTIONS), [
			["recent", []],
			["projects", []],
			["folders", []],
			["archive", []],
		]);
		// Forever keeps every session in view.
		const settings = await holdIn(fixture.browser(), SidebarSettings, {}, "owner");
		await settings.setWindow({ key: "folders", window: "forever" }, BACKGROUND_CONTEXT);
		await browser.wait(
			`!document.querySelector('.list-page .aged') && document.querySelectorAll('.sidebar-section[data-key=folders] .sidebar-group').length===2`,
		);
		await settings.setWindow({ key: "folders", window: "3d" }, BACKGROUND_CONTEXT);
	});

	it("collapses a rollup, sets its window and place from its options, and starts a session in a folder from its +", async () => {
		await browser.close();
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(1280, 900);
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const settings = await holdIn(owner, SidebarSettings, {}, "owner");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(`document.querySelector('.sidebar-section[data-key=projects] .session-main')`);

		// Collapsing keeps the rollup's name, without its sessions; the choice is kept.
		await browser.click(".sidebar-section[data-key=projects] .section-toggle");
		await until(settings.collapsed, (collapsed) => collapsed?.projects === true);
		await browser.wait(`!document.querySelector('.sidebar-section[data-key=projects] .session-main')`);
		await browser.click(".sidebar-section[data-key=projects] .section-toggle");
		await until(settings.collapsed, (collapsed) => collapsed?.projects === false);

		// A rollup's options: its window, and its place among the rollups.
		await browser.click('.sidebar-section[data-key=folders] button[aria-label="Folders options"]');
		await browser.wait(`document.querySelector('[role=dialog][aria-label=Folders]')`);
		await browser.evaluate(clickInSheet("1 week"));
		await until(settings.windows, (windows) => windows?.folders === "1w");
		await browser.evaluate(clickInSheet("Move up"));
		await until(settings.order, (order) => order?.[1] === "folders");
		await browser.wait(`document.querySelectorAll('.sidebar-section')[1]?.dataset.key==='folders'`);
		await browser.evaluate("history.back()");
		await browser.wait(`!document.querySelector('[role=dialog]')`);

		// A folder's "+" starts a session in that folder.
		const home = folderKey(null, fixture.workspace);
		await browser.click(`.sidebar-group[data-key=${JSON.stringify(home)}] .group-new`);
		await browser.wait(`!document.querySelector('.offline') && document.body.textContent.includes('Faux Model')`);
		await browser.evaluate(
			`(() => { const t=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'In the folder');t.dispatchEvent(new Event('input',{bubbles:true})); })()`,
		);
		await browser.click("button[aria-label=Send]");
		await browser.wait(`location.pathname.startsWith('/s/')`);
		const created = await until(sessions.sessions, (list) =>
			list?.some((row) => row.title.startsWith("In the folder")),
		);
		assert.equal(created?.find((row) => row.title.startsWith("In the folder"))?.cwd, fixture.workspace);
	});
});
