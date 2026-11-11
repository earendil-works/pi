// A custom view's room in Chromium (docs/rooms.md): two browsers show one view, each frame loads the view kit and
// opens its own link with a token its page got; text typed in one frame shows in the other, each sees the other in
// the room, and the agent's call runs in the leader's frame. Fake provider, a disposable session.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { ViewLinks } from "../../plugins/views/room-contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { viewKey } from "../../src/runtime/principals.ts";
import { Server } from "../../src/runtime/server.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

/** A shared note: a text room bound to a textarea, the peers it sees, and a method the agent may call. */
const NOTE = `<!doctype html><html><head></head><body>
<textarea id=note></textarea><p id=peers></p>
<script>
const text = p2view.room('text');
text.bind(document.getElementById('note'));
setInterval(() => { document.getElementById('peers').textContent = String(text.peers.length); }, 100);
p2view.methods.offer({
	length: { description: 'The note length', args: { type: 'object' }, run: async () => ({ length: text.value.length }) },
});
</script></body></html>`;

/** A live room: the frame's peer ID, how many peers it sees, and the messages it got. */
const LIVE = `<!doctype html><html><head></head><body>
<p id=me></p><p id=peers></p><p id=got></p>
<script>
const room = p2view.room('live');
room.onMessage((message) => { document.getElementById('got').textContent += message.data + ';'; });
setInterval(() => {
	document.getElementById('me').textContent = room.me;
	document.getElementById('peers').textContent = String(room.peers.length);
}, 100);
window.say = (text) => room.send(text);
</script></body></html>`;

describe("view rooms in Chromium", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	const browsers: Browser[] = [];
	let calls = 0;

	/** Has the agent run `line` (calling `tool`); its result's text. */
	const prompt = async (tool: string, line: string): Promise<string> => {
		const results = (value: typeof chat.view.value) =>
			(value?.entries ?? []).flatMap((entry) =>
				(entry.model ?? []).filter(
					(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool,
				),
			);
		const before = results(chat.view.value).length;
		await chat.send({ text: line, requestId: `ui-rooms-${++calls}` }, BACKGROUND_CONTEXT);
		const view = await until(
			chat.view,
			(value) => results(value).length === before + 1 && !(value?.docs["pi.live"] as { run?: unknown })?.run,
		);
		return (results(view).at(-1)?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
	};

	/** The note frame's textarea value in `browser`. */
	const note = (browser: Browser) =>
		browser.evaluateInFrame<string>("view=note", "document.getElementById('note').value").catch(() => "");

	before(async () => {
		fixture = await startFixture({ web: true });
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace, title: "Rooms" }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await prompt(
			"view",
			`view ${JSON.stringify({ action: "open", kind: "custom", title: "Live", id: "live", html: LIVE })}`,
		);
		await prompt(
			"view",
			`view ${JSON.stringify({ action: "open", kind: "custom", title: "Note", id: "note", html: NOTE })}`,
		);
		for (let n = 0; n < 2; n++) {
			const browser = await Browser.start();
			browsers.push(browser);
			await browser.signIn(fixture.owner);
			await browser.metrics(1400, 860);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
			await browser.wait(`document.querySelector('.views-frame')`);
		}
	});
	after(async () => {
		for (const browser of browsers) await browser.close();
		await fixture?.close();
	});

	it("shares the text between two frames, which see each other", async () => {
		const [first, second] = browsers;
		assert.ok(first && second);
		for (const browser of browsers)
			await poll(
				() =>
					browser
						.evaluateInFrame<string>("view=note", "document.getElementById('peers').textContent")
						.then((peers) => peers === "2")
						.catch(() => false),
				20_000,
				"both frames in the room",
			);
		await first.evaluateInFrame(
			"view=note",
			`(() => { const t = document.getElementById('note'); t.focus(); t.value = 'hello'; t.dispatchEvent(new Event('input')); })()`,
		);
		await poll(async () => (await note(second)) === "hello", 20_000, "the other frame shows the text");
		await second.evaluateInFrame(
			"view=note",
			`(() => { const t = document.getElementById('note'); t.value = 'hello world'; t.dispatchEvent(new Event('input')); })()`,
		);
		await poll(async () => (await note(first)) === "hello world", 20_000, "and back");
	});

	it("goes on after a reconnect when the messages it missed are gone", async () => {
		const [first, second] = browsers;
		assert.ok(first && second);
		const inFrame = <T>(browser: Browser, expression: string) =>
			browser.evaluateInFrame<T>("view=live", expression).catch(() => undefined);
		const peers = (browser: Browser, count: string) =>
			poll(
				async () => (await inFrame<string>(browser, "document.getElementById('peers').textContent")) === count,
				20_000,
				`${count} peers`,
			);
		await peers(first, "2");
		await peers(second, "2");
		const link = await inFrame<string>(second, "document.getElementById('me').textContent");
		assert.ok(link);
		// The second frame's link is cut; the first goes on alone, and its acknowledgement drops what it sent.
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Server, {})).revokeFrames({ link }, ctx),
			BACKGROUND_CONTEXT,
		);
		await inFrame(first, "say('missed 1'); say('missed 2')");
		// The second frame reconnects as a new peer, behind the first one's window, and still gets what follows.
		await poll(
			async () => {
				const me = await inFrame<string>(second, "document.getElementById('me').textContent");
				return me !== undefined && me !== "" && me !== link;
			},
			20_000,
			"a new link",
		);
		await peers(first, "2");
		await inFrame(first, "say('after')");
		await poll(
			async () =>
				((await inFrame<string>(second, "document.getElementById('got').textContent")) ?? "").includes("after"),
			20_000,
			"the message after the reconnect",
		);
	});

	it("starts over when it reconnects to a new store after the old one ended", async () => {
		const [first, second] = browsers;
		assert.ok(first && second);
		const inFrame = <T>(browser: Browser, expression: string) =>
			browser.evaluateInFrame<T>("view=live", expression).catch(() => undefined);
		const got = (browser: Browser) =>
			inFrame<string>(browser, "document.getElementById('got').textContent").then((text) => text ?? "");
		await poll(
			async () => (await inFrame<string>(second, "document.getElementById('peers').textContent")) === "2",
			20_000,
			"2 peers",
		);
		// The second frame has applied a few numbers of this store.
		for (let n = 0; n < 5; n++) await inFrame(first, `say('old ${n}')`);
		await poll(async () => (await got(second)).includes("old 4"), 20_000, "the old messages");
		// Both frames lose their links and stay away past the store's linger (their requests for tokens go nowhere: their
		// `parent` is replaced for a while): the store ends.
		const tokens = (browser: Browser, given: boolean) =>
			inFrame(
				browser,
				given
					? "window.parent = window.p2TestParent"
					: "window.p2TestParent = parent; window.parent = { postMessage() {} }",
			);
		await Promise.all([tokens(first, false), tokens(second, false)]);
		const owner = fixture.browser();
		const links = await holdIn(owner, ViewLinks, { session }, "viewer");
		const { opening } = await links.token({ view: "live" }, BACKGROUND_CONTEXT);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Server, {})).revokeFrames({ view: viewKey(session, "live", opening) }, ctx),
			BACKGROUND_CONTEXT,
		);
		await new Promise((resolve) => setTimeout(resolve, 12_000));
		await Promise.all([tokens(first, true), tokens(second, true)]);
		// A new store numbers from 0 again: the second frame takes its messages all the same.
		await poll(
			async () => (await inFrame<string>(second, "document.getElementById('peers').textContent")) === "2",
			40_000,
			"both back",
		);
		await inFrame(first, "say('new store')");
		await poll(async () => (await got(second)).includes("new store"), 20_000, "the new store's message");
	});

	it("runs the agent's call in the leader's frame", async () => {
		const result = await prompt(
			"codemode",
			`codemode return JSON.stringify(await tools.view_call({ view: "note", method: "length", args: {} }))`,
		);
		assert.match(result, /"length":11/);
	});
});
