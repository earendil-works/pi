// Browser: the command menu's conversation commands (plugins/subagents/commands.tsx) for the owner and a guest.

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { type Child, SubagentControl, Subagents } from "../../plugins/subagents/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const TITLES = `[...document.querySelectorAll('.command-menu [role=option] .command-title')].map((e) => e.textContent)`;
const SELECTED = `document.querySelector('.command-menu [role=option][aria-selected=true] .command-title')?.textContent`;
/** Each row of the open page: title, suffix, checked. */
const ROWS = `[...document.querySelectorAll('.command-menu [role=option]')].map((o) => [o.querySelector('.command-title').textContent, o.querySelector('.command-suffix-text')?.textContent ?? null, o.getAttribute('aria-checked') === 'true'])`;
const CLOSED = `!document.querySelector('.command-menu')`;

const KEYS = {
	k: { code: "KeyK", keyCode: 75, modifiers: 4 },
	Enter: { code: "Enter", keyCode: 13, modifiers: 0 },
	Escape: { code: "Escape", keyCode: 27, modifiers: 0 },
};

/** What a subagent's report makes the main conversation answer (the fake provider echoes it). */
const REPORTED = "Echo: [answered, no reply needed]";
const reports = (view: ConversationView | null | undefined) => JSON.stringify(view ?? null).split(REPORTED).length - 1;

describe("command menu conversations", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let subagents: RefIn<typeof Subagents, "reader">;
	let base: string;
	let userAgent: string;
	let team: string;
	let worktree: string;
	let turns = 0;

	/** Sends `text` to `session`'s main conversation and waits until it is idle after `reported` more reports. */
	const converse = async (session: string, text: string, reported: number) => {
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		try {
			const before = reports(chat.view.value);
			await chat.send({ text, requestId: `turn-${++turns}` }, BACKGROUND_CONTEXT);
			await until(
				chat.view,
				// SAFETY: Durable keeps the run state in the "pi.live" document as a LiveState.
				(view) => !(view?.docs["pi.live"] as LiveState | undefined)?.run && reports(view) >= before + reported,
				30_000,
			);
		} finally {
			chat.release();
		}
	};

	const spawn = (session: string, name: string, cwd?: string) =>
		converse(
			session,
			// JSON drops an undefined cwd.
			`subagent ${JSON.stringify({ action: "spawn", name, message: `hello ${name}`, tools: ["read"], cwd })}`,
			1,
		);

	const child = (name: string): Child => {
		const found = subagents.children.value[team]?.find((each) => each.name === name);
		assert.ok(found, `no subagent ${name}`);
		return found;
	};

	before(async () => {
		fixture = await startFixture({ web: true });
		owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		sessions = await holdIn(owner, Sessions, {}, "owner");
		subagents = await holdIn(owner, Subagents, {}, "reader");
		team = (await sessions.create({ cwd: fixture.workspace, title: "Team" }, BACKGROUND_CONTEXT)).id;
		worktree = join(fixture.workspace, "wt");
		mkdirSync(worktree);
		await spawn(team, "helper");
		await spawn(team, "worktree", worktree);
		// A one-shot agent, never listed.
		await converse(
			team,
			`codemode return await tools.agent({ prompt: 'json {"ok":true}', label: "Check ok", schema: { type: "object" }, tools: [] });`,
			0,
		);
		// The most recent subagent, archived: listed last all the same.
		await spawn(team, "old");
		const control = await holdIn(owner, SubagentControl, { session: team }, "participant");
		await control.archive({ conversation: child("old").conversationId, archived: true }, BACKGROUND_CONTEXT);
		control.release();
		await until(subagents.children, (value) => value?.[team]?.find((each) => each.name === "old")?.archived === true);
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		// SAFETY: DevTools' Browser.getVersion answers with a userAgent string.
		userAgent = ((await browser.call("Browser.getVersion")) as { userAgent: string }).userAgent;
		base = `http://127.0.0.1:${fixture.server.port}`;
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	const press = async (key: keyof typeof KEYS, page: Browser = browser) => {
		const { code, keyCode, modifiers } = KEYS[key];
		const event = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
		await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
		await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...event });
	};

	/** Opens `path` as a macOS page and waits for the top bar's `title`: the session and its subagents are known. */
	const load = async (path: string, title: string, page: Browser = browser) => {
		await page.metrics(1280, 800);
		await page.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
		await page.open(`${base}${path}`);
		await page.wait(`document.querySelector('.topbar h1')?.textContent === ${JSON.stringify(title)}`);
	};

	const openMenu = async (page: Browser = browser) => {
		await press("k", page);
		await page.wait(`document.activeElement?.matches('.command-menu input')`);
	};

	/** Types `query` into the open menu and presses Enter once `title` is highlighted. */
	const run = async (query: string, title: string, page: Browser = browser) => {
		await page.call("Input.insertText", { text: query });
		await page.wait(`${SELECTED} === ${JSON.stringify(title)}`);
		await press("Enter", page);
	};

	const openConversations = async (page: Browser = browser) => {
		await run("switch conv", "Switch conversation…", page);
		await page.wait(`${TITLES}.includes('Main conversation')`);
	};

	const atPath = (path: string, page: Browser = browser) => page.wait(`location.pathname === ${JSON.stringify(path)}`);

	it("lists the main conversation, then the subagents by recent activity, the archived one last", async () => {
		await load(`/s/${team}`, "Team");
		await openMenu();
		await openConversations();
		assert.deepEqual(await browser.evaluate(ROWS), [
			["Main conversation", "faux-1", true],
			["worktree", `faux-1 · ${worktree}`, false],
			["helper", "faux-1", false],
			["old", "Archived · faux-1", false],
		]);
		await press("Escape");
		await browser.wait(CLOSED);
	});

	it("opens a subagent from the root search, and Back to main conversation only there", async () => {
		const plain = (await sessions.create({ cwd: fixture.workspace, title: "Plain" }, BACKGROUND_CONTEXT)).id;
		await load(`/s/${plain}`, "Plain");
		await openMenu();
		const titles = await browser.evaluate<string[]>(TITLES);
		assert.ok(!titles.includes("Switch conversation…") && !titles.includes("Back to main conversation"));
		await press("Escape");
		await load(`/s/${team}`, "Team");
		await openMenu();
		await run("helper", "helper");
		await atPath(`/s/${team}/c/${child("helper").conversationId}`);
		await openMenu();
		await run("main", "Back to main conversation");
		await atPath(`/s/${team}`);
	});

	it("lets a guest of a shared session switch its conversations", async () => {
		const sharing = owner.hold(Sharing, { session: team }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const [link] = await until(sharing.links, (value) => value?.length === 1);
		assert.ok(link);
		const guest = await Browser.start();
		try {
			await guest.metrics(1280, 800);
			await guest.call("Emulation.setUserAgentOverride", { userAgent, platform: "MacIntel" });
			// A fresh profile on loopback gets the join form (loopback-join.test.ts).
			await guest.open(`${base}${new URL(link.url).pathname}`);
			await guest.wait(`document.querySelector('#join #name')`);
			await guest.evaluate(
				`(() => { const input = document.querySelector('#name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Reader'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
			);
			await guest.click("#join button");
			await guest.wait(`document.querySelector('.subagent-bar')?.textContent.includes('Joined as Reader')`);
			await openMenu(guest);
			await openConversations(guest);
			assert.deepEqual(
				(await guest.evaluate<[string][]>(ROWS)).map(([title]) => title),
				["Main conversation", "worktree", "helper", "old"],
			);
		} finally {
			await guest.close();
			sharing.release();
		}
	});
});
