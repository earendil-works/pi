// Browser: the page recovers instead of going blank, and state from before 2026-11-12 opens. At phone width an md and
// an html artifact view show on their own; a session whose views document an older version wrote (custom views, `path`,
// an arrangement naming a removed view) with an older page's layout opens an md artifact view; a page that fails
// outside every pane shows the error with Reload and a reset of the session's saved state, and the owner's notices get
// it. The fixture plugin (test/fixtures/recovery-plugin) writes the old document and can fail on purpose. Fake
// provider, disposable data.
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { LogNotices } from "../../plugins/logs/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** The owner's artifact of the night it happened (a table, inline code). */
const NOTES = [
	"# Artifacts, as of tonight",
	"",
	"- **Owned by plugins**, stored on the server, keyed by the session: export, import and delete carry them.",
	"- **Tools** are code-mode only, grouped in the `artifact` namespace.",
	"- **Views** only show things: `view_open({ kind, item })`.",
	"",
	"| Tool | Does |",
	"| --- | --- |",
	"| artifact_write | a new artifact or a new version |",
	"| artifact_open | beside the chat |",
	"",
].join("\n");

/** Collects what the page throws or logs as an error, from its first script on. */
const CAPTURE = `window.__errors = [];
addEventListener('error', (e) => window.__errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => window.__errors.push('rejection ' + String(e.reason?.message ?? e.reason)));`;

/** The md artifact's view: its ID made from its title. */
const MD = "artifacts-what-changed-tonight";

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter((message): message is ToolResultMessage => message.role === "toolResult"),
	);

describe("page recovery and old state", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let sent = 0;

	/** Has `session`'s agent run `text` (a fake-provider prompt) to the end of its turn; that turn's result. */
	const run = async (session: string, text: string): Promise<ToolResultMessage | undefined> => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const before = results(chat.view.value).length;
		await chat.send({ text, requestId: `run-${++sent}` }, BACKGROUND_CONTEXT);
		const view = await until(
			chat.view,
			(value) => results(value).length > before && !(value?.docs["pi.live"] as { run?: unknown })?.run,
		);
		chat.release();
		const result = results(view).at(-1);
		assert.equal(result?.isError, false, JSON.stringify(result?.content));
		return result;
	};

	const newSession = async (title: string): Promise<string> =>
		(await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
	/** The owner's md artifact and an html one, opened as views (the md one last: in front). */
	const openArtifacts = (id: string) =>
		run(
			id,
			`codemode ${[
				`await tools.artifact_write({ id: "counter", kind: "html", title: "Counter", content: "<button id=add>+1</button>" });`,
				`await tools.artifact_write({ id: "notes", kind: "md", title: "Artifacts: what changed tonight", content: ${JSON.stringify(NOTES)} });`,
				`await tools.artifact_open({ id: "counter" });`,
				`await tools.artifact_open({ id: "notes" });`,
			].join("\n")}`,
		);

	const errors = () => browser.evaluate<string[]>("window.__errors");
	const shown = "[...document.querySelectorAll('.views-pane:not([hidden])')].map((pane) => pane.dataset.viewPane)";

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "notes.md"), "# Notes\n");
		cpSync(new URL("../fixtures/recovery-plugin", import.meta.url), join(fixture.dataDir, "plugins", "recovery"), {
			recursive: true,
		});
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		const setup = (await sessions.create({ cwd: fixture.workspace, title: "Setup" }, BACKGROUND_CONTEXT)).id;
		await run(setup, "reload_plugins {}");
		browser = await Browser.start();
		await browser.call("Page.addScriptToEvaluateOnNewDocument", { source: CAPTURE });
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("shows an md and an html artifact view on their own at phone width", async () => {
		const id = await newSession("Phone views");
		await openArtifacts(id);
		await browser.metrics(390, 844);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		// The agent showed the md view last: the phone shows it, alone.
		await browser.wait(`${shown}.join() === '${MD}' && document.querySelector('[data-view-pane=${MD}] table')`);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('[data-view-pane=${MD}]').textContent`),
			/Artifacts, as of tonight/,
		);
		await browser.evaluate(
			"[...document.querySelectorAll('.views-tabs.phone .views-tab')].find((tab) => tab.textContent === 'Counter').click()",
		);
		await browser.wait(`${shown}.join() === 'counter' && document.querySelector('[data-view-pane=counter] iframe')`);
		assert.deepEqual(await errors(), []);
	});

	it("opens an md artifact view at phone width in a session whose views and layout an older version wrote", async () => {
		const id = await newSession("Old state");
		await run(id, "codemode await tools.seed_old_views({});");
		await openArtifacts(id);
		await browser.metrics(390, 844);
		// The layout an older page kept: the custom view placed and in front on the phone.
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.evaluate(
			`localStorage.setItem('p2.views.layout:${id}', JSON.stringify({ tree: { kind: 'split', id: 's1', dir: 'row', children: [{ kind: 'area', id: 'a1', views: ['transcript'], active: 'transcript' }, { kind: 'area', id: 'a2', views: ['glyph', 'notes'], active: 'glyph' }], sizes: [0.5, 0.5] }, hidden: [], focus: { glyph: 1 }, phone: 'glyph', arranged: 0 }))`,
		);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		// The old arrangement names only the removed custom view: it hides nothing.
		await browser.wait(`${shown}.join() === '${MD}' && document.querySelector('[data-view-pane=${MD}] table')`);
		const tabs = await browser.evaluate<string[]>(
			"[...document.querySelectorAll('.views-tabs.phone .views-tab')].map((tab) => tab.textContent)",
		);
		assert.deepEqual(tabs, ["Chat", "Notes", "Changes", "Counter", "Artifacts: what changed tonight"]);
		assert.deepEqual(await errors(), []);
	});

	it("shows a failure outside every pane with Reload and a reset of the session's saved state, and reports it", async () => {
		const id = await newSession("Failing page");
		await browser.metrics(1280, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/`);
		await browser.evaluate(
			`localStorage.setItem('p2-test-crash:${id}', '1'); localStorage.setItem('p2.views.layout:${id}', 'kept by an older page')`,
		);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait("document.querySelector('[data-testid=page-failed]')");
		assert.match(
			await browser.evaluate<string>("document.querySelector('[data-testid=page-failed]').textContent"),
			/The test's crash/,
		);
		// The owner's notices tell of it.
		const notices = await holdIn(owner, LogNotices, {}, "owner");
		await until(notices.notices, (value) =>
			value.some((notice) => notice.source === "web" && notice.message.includes("The test's crash")),
		);
		// Reset forgets what the device kept for the session (the failure's flag among it); the page loads.
		await browser.evaluate(
			"[...document.querySelectorAll('[data-testid=page-failed] button')].find((button) => button.textContent.startsWith('Reset')).click()",
		);
		await browser.wait(
			"!document.querySelector('[data-testid=page-failed]') && document.querySelector('.composer textarea')",
		);
		assert.deepEqual(
			await browser.evaluate<(string | null)[]>(
				`[localStorage.getItem('p2-test-crash:${id}'), localStorage.getItem('p2.views.layout:${id}')]`,
			),
			[null, null],
		);
	});
});
