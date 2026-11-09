// Chat mode in a real server with a plugin subset: what the fake provider receives (P2_FAKE_REQUESTS), mentions with
// their digest and attachments, a chat message during a run, and guests. Guests join through a loopback server with
// an allowed tunnel Host (share.test); no tunnel or real provider takes part.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { ChatMode } from "../../plugins/chat-mode/contract.ts";
import { MAX_DIGEST_IMAGES } from "../../plugins/chat-mode/digest.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Access } from "../../src/runtime/access.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { expectChord, type Fixture, holdIn, http, poll, startFixture, until } from "./helpers.ts";

const TUNNEL = { Host: "share.test", Origin: "https://share.test" };
type Logged = { role: string; content: string | { type: string; text?: string }[] };
const live = (view: ConversationView | null | undefined): LiveState | undefined =>
	view?.docs["pi.live"] as unknown as LiveState | undefined;
const chatEntries = (view: ConversationView | null | undefined) =>
	(view?.entries ?? []).filter((entry) => entry.kind === "chat.message");
const textOf = (message: Logged): string =>
	typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");

describe("chat mode (server, sharing, fake provider)", () => {
	let fixture: Fixture;
	let scratch: string;
	let requestLog: string;
	let owner: Host;
	let session: string;
	let chat: RefIn<typeof Chat, "participant">;
	let mode: RefIn<typeof ChatMode, "owner">;

	/** Every request the fake provider received so far: one list of messages per request. */
	const requests = (): Logged[][] =>
		existsSync(requestLog)
			? readFileSync(requestLog, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Logged[])
			: [];
	const upload = async (name: string, body: string | Buffer, headers: Record<string, string> = {}) => {
		const response = await fixture.http(`/upload?${new URLSearchParams({ session, name })}`, {
			method: "POST",
			headers: { Origin: `http://127.0.0.1:${fixture.server.port}`, ...headers },
			body,
		});
		assert.equal(response.status, 200, response.body);
		return (JSON.parse(response.body) as { id: string }).id;
	};
	/** Joins through the session's `mode` link as `name`: a WebSocket client carrying the guest cookie. */
	const joinAs = async (linkMode: "view" | "full", name: string) => {
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: linkMode }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.some((link) => link.mode === linkMode)));
		const token = links?.find((link) => link.mode === linkMode)?.token;
		const response = await http(fixture.server.port, "/join", {
			method: "POST",
			headers: { ...TUNNEL, "Content-Type": "application/json" },
			body: JSON.stringify({ token, name }),
		});
		assert.equal(response.status, 200, response.body);
		const cookie = String(response.headers["set-cookie"] ?? "").split(";")[0] ?? "";
		const host = fixture.client({ ...TUNNEL, Cookie: cookie }).host;
		const grant = await until((await holdIn(host, Access, {}, "guest")).grant, Boolean);
		return { host, cookie, id: grant?.id ?? "" };
	};
	const idle = () =>
		until(chat.view, (view) => Boolean(view) && !live(view)?.run && !(live(view)?.tools?.length ?? 0));

	before(async () => {
		scratch = mkdtempSync(join(tmpdir(), "p2-chat-mode-"));
		requestLog = join(scratch, "requests.jsonl");
		fixture = await startFixture({
			// Exactly these: the model requests below are checked against this tool and prompt set.
			plugins: [
				"chat",
				"chat-mode",
				"conversations",
				"devices",
				"drafts",
				"envs",
				"files",
				"models",
				"search",
				"sessions",
				"sharing",
				"status",
				"subagents",
			],
			allowedHosts: ["share.test"],
			workerEnv: { P2_FAKE_REQUESTS: requestLog },
		});
		owner = fixture.browser();
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Chat" }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		mode = await holdIn(owner, ChatMode, { session, conversation: 1 }, "owner");
		// Stay subscribed: an unsubscribed remote member restarts from undefined (requests #8).
		follow(chat.view, () => {});
	});

	after(async () => {
		await fixture?.close();
		rmSync(scratch, { recursive: true, force: true });
	});

	it("loads exactly the named plugins", () => {
		assert(fixture.server.plugins.includes("chat-mode"));
		assert(!fixture.server.plugins.includes("terminals"));
	});

	it("keeps chat messages out of every model request, idle or during a run", async () => {
		assert.equal(mode.variant, "owner");
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === true);
		await chat.send({ text: "hello people", requestId: "c1" }, BACKGROUND_CONTEXT);
		const [entry] = chatEntries(await until(chat.view, (view) => chatEntries(view).length === 1));
		assert.deepEqual(entry?.data, {
			author: { kind: "owner", id: "owner", name: "Owner" },
			text: "hello people",
			attachments: [],
		});
		assert.equal(entry?.model, undefined, "a chat entry has no model message");
		assert.deepEqual(requests(), [], "nothing was sent to the model");

		// Chat mode off: an ordinary input. It starts a run whose tool sleeps; chat mode goes on meanwhile.
		await mode.set({ enabled: false }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === false);
		await chat.send({ text: "slow-tool", requestId: "run" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => (live(view)?.tools?.length ?? 0) > 0);
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === true);
		await chat.send({ text: "while the tool runs", requestId: "c2" }, BACKGROUND_CONTEXT);
		// A data-only write is placed at once, even while the tool runs.
		const during = await until(chat.view, (view) => chatEntries(view).length === 2);
		assert(live(during)?.run, "placed during the run");
		await until(mode.waiting, (value) => value === 2);
		const view = (await idle())!;
		const all = JSON.stringify(requests());
		assert(!all.includes("hello people") && !all.includes("while the tool runs"), all);
		// The run went on as if nobody had chatted: the tool result, then the usual echo.
		assert.deepEqual(
			requests().map((request) => request.at(-1)?.role),
			["user", "toolResult"],
		);
		assert(JSON.stringify(view.entries.at(-1)?.model ?? view.entries.at(-2)?.model).includes("Echo: slow-tool"));
	});

	it("gives a mention the chat no mention passed on yet, with authors, attachments and capped images", async () => {
		const png = Buffer.from("89504e470d0a1a0a", "hex");
		const alice = await joinAs("full", "Alice");
		const [aliceChat, aliceMode] = await Promise.all([
			holdIn(alice.host, Chat, { session, conversation: 1 }, "participant"),
			holdIn(alice.host, ChatMode, { session, conversation: 1 }, "reader"),
		]);
		// @ts-expect-error `set` is the owner's: a reader calling it anyway is refused.
		await expectChord(aliceMode.set({ enabled: false }, BACKGROUND_CONTEXT), "invalid");

		const guestUpload = (name: string) => upload(name, png, { ...TUNNEL, Cookie: alice.cookie });
		const images = [await guestUpload("a.png"), await guestUpload("b.png"), await guestUpload("c.png")];
		await aliceChat.send({ text: "screenshots", requestId: "a1", attachments: images }, BACKGROUND_CONTEXT);
		const notes = await upload("notes.txt", "remember the milk");
		const more = [await upload("d.png", png), await upload("e.png", png)];
		await chat.send({ text: "my notes", requestId: "o1", attachments: [notes, ...more] }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => chatEntries(view).length === 4);
		const before = requests().length;

		// A client cannot choose its author: the arguments are closed, so the extra field is refused; the principal
		// decides who wrote what is sent.
		await expectChord(
			aliceChat.send(
				{
					text: "@Pi, what do you think?",
					requestId: "m0",
					author: { kind: "owner", id: "owner", name: "Owner" },
				} as never,
				BACKGROUND_CONTEXT,
			),
			"invalid",
		);
		await aliceChat.send({ text: "@Pi, what do you think?", requestId: "m1" }, BACKGROUND_CONTEXT);
		await poll(() => requests().length > before, 20_000, "the mention's request");
		const asked = requests()[before]!.at(-1)!;
		assert.equal(asked.role, "user");
		const text = textOf(asked);
		assert.match(text, /<sender kind="guest" id="[^"]+" name="Alice"\/>/);
		assert.match(text, /^Alice \(guest\): screenshots \[attached: a\.png, b\.png, c\.png\]$/m);
		assert.match(text, /^Owner: my notes \[attached: notes\.txt, d\.png, e\.png\]$/m);
		assert.match(text, /Alice \(guest\) mentioned you:\n@Pi, what do you think\?/);
		assert.match(text, /^Owner: hello people$/m, "chat never passed on goes with the first mention");
		for (const name of ["a.png", "b.png", "c.png", "notes.txt", "d.png", "e.png"]) assert(text.includes(`(${name},`));
		const inlined = (asked.content as { type: string }[]).filter((part) => part.type === "image");
		assert.equal(inlined.length, MAX_DIGEST_IMAGES, "only the newest images are inlined");
		// People see the mention from its entry's data: Alice's own words, and which chat went with it.
		const view = await idle();
		const placed = view?.entries.find((entry) => entry.kind === "chat.mention");
		const data = placed?.data as { author: unknown; text: string; included: number[] };
		assert.deepEqual(data.author, { kind: "guest", id: alice.id, name: "Alice" });
		assert.equal(data.text, "@Pi, what do you think?");
		assert.equal(data.included.length, 4);
	});

	it("lets read-only guests read chat mode but not write", async () => {
		const bob = await joinAs("view", "Bob");
		const [bobChat, bobMode] = await Promise.all([
			holdIn(bob.host, Chat, { session, conversation: 1 }, "viewer"),
			holdIn(bob.host, ChatMode, { session, conversation: 1 }, "reader"),
		]);
		assert.equal(await until(bobMode.enabled, (value) => value === true), true);
		// @ts-expect-error `send` is a participant's: a viewer calling it anyway is refused.
		await expectChord(bobChat.send({ text: "hi", requestId: "b1" }, BACKGROUND_CONTEXT), "invalid");
	});
});
