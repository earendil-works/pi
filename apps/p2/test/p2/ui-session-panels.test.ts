// The right-hand panels belong to the session they were opened in (src/web/session-panels.ts): switching sessions shows
// the next session's own panels (none if it never had any), switching back restores the first one's, a page load from
// a link restores them too, and on phones only the terminal below the chat comes back. Fake provider, disposable data.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { ArtifactList } from "../../plugins/artifacts/contract.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("panels per session", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser;
	const ids: Record<string, string> = {};
	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		for (const title of ["Files here", "Terminal here", "Artifacts here", "Nothing here"])
			ids[title] = (await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
		const session = ids["Artifacts here"] as string;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		const list = owner.hold(ArtifactList, { session, conversation: 1 }, BACKGROUND_CONTEXT);
		await chat.send({ text: "artifact", requestId: "artifact" }, BACKGROUND_CONTEXT);
		await until(list.artifacts, (artifacts) => artifacts?.length === 1);
		list.release();
		chat.release();
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	const url = (title: string) => `http://127.0.0.1:${fixture.server.port}/s/${ids[title]}`;
	const row = (title: string) =>
		`[...document.querySelectorAll('.drawer .session-main')].find((e) => e.querySelector('.session-title')?.textContent === ${JSON.stringify(title)})`;
	const shown = {
		workspace: `Boolean(document.querySelector('.workspace'))`,
		terminal: `Boolean(document.querySelector('.terminal-panel'))`,
		artifacts: `Boolean(document.querySelector('[data-testid=artifact-panel]'))`,
	};
	/** Which panels show once `title` is open. */
	async function panels(title: string): Promise<string[]> {
		await browser.wait(
			`location.pathname === '/s/${ids[title]}' && document.querySelector('.topbar h1')?.textContent === ${JSON.stringify(title)} && !document.querySelector('.offline')`,
		);
		// Panels render with the route; give the held objects a moment to render their content.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const open: string[] = [];
		for (const [name, expression] of Object.entries(shown))
			if (await browser.evaluate<boolean>(expression)) open.push(name);
		return open;
	}
	async function switchTo(title: string): Promise<string[]> {
		await browser.evaluate(`${row(title)}.click()`);
		return panels(title);
	}

	it("restores each session's own panels when switching sessions and after a page load", async () => {
		await browser.metrics(1400, 900);
		await browser.open(url("Files here"));
		assert.deepEqual(await panels("Files here"), []);
		await browser.click('button[aria-label="Workspace files and changes"]');
		await browser.wait(shown.workspace);

		// The workspace stays with its session: the next one opens without it, and opens a terminal below the chat.
		assert.deepEqual(await switchTo("Terminal here"), []);
		await browser.evaluate(`localStorage.setItem('p2-terminal-position', 'bottom')`);
		await browser.click(".topbar button[aria-label=Terminal]");
		await browser.wait(shown.terminal);

		assert.deepEqual(await switchTo("Artifacts here"), []);
		await browser.click('button[aria-label="Artifacts (1)"]');
		await browser.wait(shown.artifacts);

		assert.deepEqual(await switchTo("Nothing here"), []);
		assert.deepEqual(await switchTo("Files here"), ["workspace"]);
		assert.deepEqual(await switchTo("Terminal here"), ["terminal"]);
		assert.deepEqual(await switchTo("Artifacts here"), ["artifacts"]);

		// Closing a panel is remembered as well.
		await browser.click("[data-testid=artifact-panel] button[aria-label=Close]");
		await browser.wait(`!${shown.artifacts}`);
		assert.deepEqual(await switchTo("Files here"), ["workspace"]);
		assert.deepEqual(await switchTo("Artifacts here"), []);

		// A page load without state of its own (a link, a new tab) opens the session with its panels.
		await browser.open(url("Terminal here"));
		assert.deepEqual(await panels("Terminal here"), ["terminal"]);
		await browser.open(url("Files here"));
		assert.deepEqual(await panels("Files here"), ["workspace"]);
		const kept = await browser.evaluate<string>(`localStorage.getItem('p2-session-panels')`);
		assert.deepEqual(
			(JSON.parse(kept) as [string, unknown][]).map(([session]) => session).sort(),
			[ids["Files here"], ids["Terminal here"]].sort(),
		);
	});

	it("restores on phones only what does not cover the chat", async () => {
		await browser.metrics(390, 844);
		// (Opening the address that is open already would be a reload, which keeps its route.)
		await browser.open(url("Nothing here"));
		assert.deepEqual(await panels("Nothing here"), []);
		// The workspace would take the whole screen: the session opens with its chat.
		await browser.open(url("Files here"));
		assert.deepEqual(await panels("Files here"), []);
		// The terminal below the chat comes back.
		await browser.open(url("Terminal here"));
		assert.deepEqual(await panels("Terminal here"), ["terminal"]);
	});
});
