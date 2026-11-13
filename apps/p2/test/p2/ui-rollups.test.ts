// Browser: rollups made from code in the sidebar (plugins/rollups, plugins/sessions/sidebar/custom.ts): a saved rollup
// shows as a section before the Archive with the groups its script returned, follows the sessions when it refreshes
// automatically, and a manual one shows its refresh, last check and failure in its options and refreshes from there.
// Fake provider, disposable data.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Models } from "../../plugins/models/contract.ts";
import { SidebarRollups } from "../../plugins/rollups/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture } from "./helpers.ts";

/** Each rollup's key, then its sessions' titles, or its groups' names with their sessions' titles. */
const SECTIONS = `[...document.querySelectorAll('.sidebar-section')].map(s=>[s.dataset.key,s.querySelector('.sidebar-group')?[...s.querySelectorAll('.sidebar-group')].map(g=>[g.querySelector('.group-link').textContent,[...g.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)]):[...s.querySelectorAll('.session-main .session-title')].map(e=>e.textContent)])`;

/** Sessions by the first word of their title, a group per word. */
const BY_WORD = `const groups = new Map();
for (const s of sessions.filter((s) => !s.archivedAt)) {
	const word = s.title.split(" ")[0];
	if (!groups.has(word)) groups.set(word, []);
	groups.get(word).push(s.id);
}
return { layout: "groups", groups: [...groups].sort().map(([word, members]) => ({ key: word, name: word, members })) };`;

describe("rollups made from code in the sidebar", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let sessions: Awaited<ReturnType<typeof holdIn<typeof Sessions, "owner">>>;
	let rollups: Awaited<ReturnType<typeof holdIn<typeof SidebarRollups, "owner">>>;
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		sessions = await holdIn(owner, Sessions, {}, "owner");
		rollups = await holdIn(owner, SidebarRollups, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(1280, 900);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	const folder = (name: string) => {
		const path = join(fixture.workspace, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const section = (key: string) =>
		browser.evaluate<[string, unknown][]>(SECTIONS).then((all) => all.find(([each]) => each === key)?.[1]);

	it("shows an automatic rollup's groups before the Archive, and follows the sessions", async () => {
		const work = folder("work");
		await sessions.create({ cwd: work, title: "Chord store" }, BACKGROUND_CONTEXT);
		await sessions.create({ cwd: work, title: "Durable replay" }, BACKGROUND_CONTEXT);
		await rollups.save(
			{ key: "by-word", name: "By word", window: "3d", refresh: { kind: "auto" }, code: BY_WORD },
			BACKGROUND_CONTEXT,
		);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.wait(
			`document.querySelectorAll('.sidebar-section[data-key="rollup:by-word"] .sidebar-group').length===2`,
		);
		const keys = await browser.evaluate<string[]>(
			`[...document.querySelectorAll('.sidebar-section')].map(s=>s.dataset.key)`,
		);
		assert.deepEqual(keys.slice(-2), ["rollup:by-word", "archive"]);
		assert.deepEqual(await section("rollup:by-word"), [
			["Chord", ["Chord store"]],
			["Durable", ["Durable replay"]],
		]);
		// A new session joins its group: the script read `title`, which a new session changes.
		await sessions.create({ cwd: work, title: "Chord links" }, BACKGROUND_CONTEXT);
		await browser.wait(
			`document.querySelectorAll('.sidebar-section[data-key="rollup:by-word"] .sidebar-group:first-child .session-main').length===2`,
		);
		// Its name opens its list in the main area, by group.
		await browser.click('.sidebar-section[data-key="rollup:by-word"] .group-label');
		await browser.wait(`document.querySelector('.list-page h1')?.textContent==='By word'`);
		assert.deepEqual(
			await browser.evaluate(`[...document.querySelectorAll('.list-page .list-group-link')].map(e=>e.textContent)`),
			["Chord", "Durable"],
		);
		await rollups.remove({ key: "by-word" }, BACKGROUND_CONTEXT);
		await browser.wait(`!document.querySelector('.sidebar-section[data-key="rollup:by-word"]')`);
	});

	it("refreshes a manual rollup from its options, which show its last check and failure", async () => {
		await rollups.save(
			{
				key: "count",
				name: "Count",
				window: "none",
				refresh: { kind: "manual" },
				code: `return { layout: "link", members: sessions.filter((s) => !s.archivedAt).map((s) => s.id) }`,
			},
			BACKGROUND_CONTEXT,
		);
		const total = () =>
			browser.evaluate<string>(
				`document.querySelector('.sidebar-section[data-key="rollup:count"] .section-count')?.textContent ?? ''`,
			);
		await browser.wait(`document.querySelector('.sidebar-section[data-key="rollup:count"] .section-count')`);
		const before = Number(await total());
		await sessions.create({ cwd: folder("more"), title: "More" }, BACKGROUND_CONTEXT);
		await browser.evaluate(
			`document.querySelector('.sidebar-section[data-key="rollup:count"]').scrollIntoView({ block: "center" })`,
		);
		await browser.click('.sidebar-section[data-key="rollup:count"] button[aria-label="Count options"]');
		await browser.wait(`document.querySelector('[role=dialog]')?.textContent.includes('Refreshes only by hand')`);
		assert.equal(Number(await total()), before);
		await browser.evaluate(
			`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='Refresh now').click()`,
		);
		await browser.wait(
			`document.querySelector('.sidebar-section[data-key="rollup:count"] .section-count')?.textContent==='${before + 1}'`,
		);
		// A failing script: its options say why, and the last good output stays.
		await rollups.save(
			{
				key: "count",
				name: "Count",
				window: "none",
				refresh: { kind: "manual" },
				code: `throw new Error("broken")`,
			},
			BACKGROUND_CONTEXT,
		);
		await browser.wait(`document.querySelector('[role=dialog] .rollup-error')?.textContent.includes('broken')`);
	});
});
