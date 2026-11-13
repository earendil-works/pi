// Chat mode on a bare session host (real Durable, fake provider): chat entries, mentions, the switch's persistence,
// and each principal's variant over memory links. Also checks the tutorial's code blocks against the code.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView, EntryRecord, InboxState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import {
	type ChatMessage,
	ChatMode,
	ChatModeSetting,
	mentionsAgent,
	mentionToken,
} from "../../plugins/chat-mode/contract.ts";
import {
	type ChatEntry,
	composeMention,
	digest,
	MAX_DIGEST_IMAGES,
	unmentioned,
} from "../../plugins/chat-mode/digest.ts";
import { ChatModeDoc } from "../../plugins/chat-mode/worker.ts";
import { durableContext } from "../../src/runtime/durable.ts";
import { chatModeHost } from "./chat-mode-host.ts";
import { expectChord, holdIn, until } from "./helpers.ts";

const OWNER = { kind: "owner", access: "local" } as const;
const ALICE = { kind: "guest", id: "alice", name: "Alice", home: "s1", sessions: { s1: "full" }, revision: 1 } as const;
const BOB = { kind: "guest", id: "bob", name: "Bob", home: "s1", sessions: { s1: "view" }, revision: 1 } as const;
const where = { session: "s1", conversation: 1 };
const chatEntries = (view: ConversationView | null | undefined) =>
	(view?.entries ?? []).filter((entry) => entry.kind === "chat.message");
const answered = (view: ConversationView | null | undefined) =>
	view?.entries.some((entry) => entry.model?.[0]?.role === "assistant") ?? false;

describe("chat-mode mentions", () => {
	it("recognizes @pi as a word of its own, in any case", () => {
		for (const text of ["@pi", "hey @Pi, look", "(@PI)", "ok @pi."]) assert(mentionsAgent(text), text);
		for (const text of ["@pizza", "me@pi", "pi", "@@pi", "@pi_bot"]) assert(!mentionsAgent(text), text);
	});

	it("recognizes a renamed agent's mention instead of @pi", () => {
		for (const text of ["@claude", "hey @Claude, look", "(@CLAUDE)"]) assert(mentionsAgent(text, "Claude"), text);
		for (const text of ["@claudette", "me@claude", "Claude", "@pi", "@claude-bot"])
			assert(!mentionsAgent(text, "Claude"), text);
		assert.equal(mentionToken("Claude"), "@claude");
		// A conversation from before names: the default.
		assert.deepEqual(ChatModeDoc.definition.migrate?.({ enabled: true }, 1), { enabled: true, name: "Pi" });
	});
});

describe("chat-mode digest", () => {
	it("names who a message answers and quotes the start of it", () => {
		const ann = { kind: "guest", id: "ann", name: "Ann" } as const;
		const bob = { kind: "guest", id: "bob", name: "Bob" } as const;
		const chat: ChatEntry[] = [
			{
				id: 7,
				message: { author: ann, text: "should we split the tokenizer and the parser work?", attachments: [] },
			},
			{
				id: 9,
				message: {
					author: bob,
					text: "yes, the tokenizer part",
					attachments: [],
					replyTo: { entryId: 7, author: ann, excerpt: "should we split…" },
				},
			},
		];
		const text = digest(chat, { kind: "owner", id: "owner", name: "Owner" }, "@pi agreed?");
		assert.match(text, /^Bob \(guest, replying to Ann: "should we split…"\): yes, the tokenizer part$/m);
		assert.match(text, /\nOwner mentioned you:\n@pi agreed\?$/);
	});

	it("composes a mention in one place: its entry's data for people, the digest for the model", () => {
		const owner = { kind: "owner", id: "owner", name: "Owner" } as const;
		const ann = { kind: "guest", id: "ann", name: "Ann" } as const;
		const file = { id: "u1", name: "plan.md", path: "/uploads/u1-plan.md", size: 3 };
		const chat: ChatEntry[] = [{ id: 4, message: { author: ann, text: "lunch?", attachments: [] } }];
		const submission = composeMention({
			author: owner,
			text: "@pi go",
			chat,
			attachments: [file],
			files: [file],
			requestId: "r",
			whenBusy: "followUp",
		});
		assert.deepEqual(submission.entry, {
			kind: "chat.mention",
			data: { author: owner, text: "@pi go", attachments: [{ id: "u1", name: "plan.md" }], included: [4] },
		});
		assert.match(
			submission.text,
			/^<chat>\n[^\n]*\nAnn \(guest\): lunch\?\n<\/chat>\n\nOwner mentioned you:\n@pi go$/,
		);
		assert.equal(submission.author, owner, "the chat plugin writes the author's speaker block for the model");
		assert.equal(submission.maxImages, MAX_DIGEST_IMAGES);
	});

	it("passes on each chat message once: a mention covers what its digest included, nothing placed after", () => {
		const ann = { kind: "guest", id: "ann", name: "Ann" } as const;
		const chatEntry = (id: number, text: string) =>
			({ id, kind: "chat.message", data: { author: ann, text, attachments: [] } }) as unknown as EntryRecord;
		const mentionEntry = (id: number, included: number[]) =>
			({
				id,
				kind: "chat.mention",
				data: { author: ann, text: "@pi", attachments: [], included },
				model: [{ role: "user", content: "digest" }],
			}) as unknown as EntryRecord;
		// Mention 5 was composed with chat 2 and 3; chat 4 was placed while it waited in the queue.
		const entries = [
			chatEntry(6, "after"),
			mentionEntry(5, [2, 3]),
			chatEntry(4, "raced"),
			chatEntry(3, "b"),
			chatEntry(2, "a"),
			chatEntry(1, "old"),
		];
		assert.deepEqual(
			unmentioned(entries).map((entry) => entry.id),
			[4, 6],
		);
		// A mention still queued covers its chat too.
		const inbox = {
			items: [
				{
					id: 99,
					mode: "followUp",
					content: "digest",
					entry: { kind: "chat.mention", data: { author: ann, text: "@pi", attachments: [], included: [4, 6] } },
				},
			],
		} as unknown as InboxState;
		assert.deepEqual(unmentioned(entries, inbox), []);
	});
});

describe("chat-mode on a bare session host", () => {
	it("keeps chat as display-only entries and gives a mention the chat with its authors", async (t) => {
		const fixture = await chatModeHost();
		t.after(() => fixture.close());
		const owner = await holdIn(fixture.client(OWNER), Chat, where, "participant");
		const mode = await holdIn(fixture.client(OWNER), ChatMode, where, "owner");
		const alice = await holdIn(fixture.client(ALICE), Chat, where, "participant");
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === true);

		await owner.send({ text: "lunch first?", requestId: "1", attachments: ["menu"] }, BACKGROUND_CONTEXT);
		await alice.send({ text: "yes", requestId: "2" }, BACKGROUND_CONTEXT);
		const chatted = await until(owner.view, (view) => chatEntries(view).length === 2);
		assert.deepEqual(
			chatEntries(chatted).map((entry) => entry.data),
			[
				{
					author: { kind: "owner", id: "owner", name: "Owner" },
					text: "lunch first?",
					attachments: [{ id: "menu", name: "menu.txt" }],
				},
				{ author: { kind: "guest", id: "alice", name: "Alice" }, text: "yes", attachments: [] },
			],
		);
		assert(!answered(chatted), "no run started");
		assert.equal(await until(mode.waiting, (value) => value === 2), 2);

		await alice.send({ text: "@pi which place?", requestId: "3" }, BACKGROUND_CONTEXT);
		const view = await until(owner.view, answered);
		// The mention is its own entry: data for people, the digest (after the speaker block) for the model.
		const asked = view?.entries.find((entry) => entry.kind === "chat.mention");
		assert.deepEqual(asked?.data, {
			author: { kind: "guest", id: "alice", name: "Alice" },
			text: "@pi which place?",
			attachments: [],
			included: chatEntries(chatted).map((entry) => entry.id),
		});
		const text = JSON.stringify(asked?.model?.[0]?.content);
		assert.match(text, /Owner: lunch first\? \[attached: menu\.txt\]\\nAlice \(guest\): yes\\n<\/chat>/);
		assert.match(text, /Alice \(guest\) mentioned you:\\n@pi which place\?/);
		assert.match(text, /menu\.txt \(menu\.txt, 1 bytes\)/, "attachments are listed by path");
		assert.equal(await until(mode.waiting, (value) => value === 0), 0, "the mention passed the chat on");
		// An ordinary input with chat mode off is a p2.input entry with the same kind of data.
		await mode.set({ enabled: false }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === false);
		await owner.send({ text: "plain", requestId: "4", attachments: ["notes"] }, BACKGROUND_CONTEXT);
		const plain = await until(owner.view, (next) =>
			Boolean(next?.entries.some((entry) => entry.kind === "p2.input")),
		);
		assert.deepEqual(plain?.entries.find((entry) => entry.kind === "p2.input")?.data, {
			author: { kind: "owner", id: "owner", name: "Owner" },
			text: "plain",
			attachments: [{ id: "notes", name: "notes.txt" }],
		});
	});

	it("places chat at once during a run, and hands chat placed while a mention waited to the next mention", async (t) => {
		const fixture = await chatModeHost();
		t.after(() => fixture.close());
		const owner = await holdIn(fixture.client(OWNER), Chat, where, "participant");
		const mode = await holdIn(fixture.client(OWNER), ChatMode, where, "owner");
		const alice = await holdIn(fixture.client(ALICE), Chat, where, "participant");
		const live = (view: ConversationView | null | undefined) => Boolean(view?.docs["pi.live"]?.run);
		await owner.send({ text: "slow run", requestId: "run" }, BACKGROUND_CONTEXT);
		await until(owner.view, live);
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === true);
		// While Pi works, a mention waits in the queue; a chat message sent after it is placed at once.
		await alice.send({ text: "@pi first", requestId: "m1", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		await owner.send({ text: "raced", requestId: "c1" }, BACKGROUND_CONTEXT);
		const during = await until(owner.view, (view) => chatEntries(view).length === 1);
		assert(live(during), "the chat message did not wait for the run");
		const [raced] = chatEntries(during);
		const mentions = (view: ConversationView | null | undefined) =>
			(view?.entries ?? []).filter((entry) => entry.kind === "chat.mention");
		const first = await until(owner.view, (view) => mentions(view).length === 1 && !live(view));
		assert.deepEqual((mentions(first)[0]?.data as { included: number[] }).included, [], "composed before the chat");
		await alice.send({ text: "@pi second", requestId: "m2" }, BACKGROUND_CONTEXT);
		const second = await until(owner.view, (view) => mentions(view).length === 2);
		assert.deepEqual((mentions(second)[1]?.data as { included: number[] }).included, [raced!.id]);
		assert.match(JSON.stringify(mentions(second)[1]?.model), /Owner: raced/);
	});

	it("keeps the switch in the conversation across a worker restart", async (t) => {
		const first = await chatModeHost();
		const mode = await holdIn(first.client(OWNER), ChatMode, where, "owner");
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await until(mode.enabled, (value) => value === true);
		await first.close({ remove: false });

		const second = await chatModeHost({ directory: first.directory });
		t.after(() => second.close());
		const again = await second.client(OWNER).get(ChatMode, where, BACKGROUND_CONTEXT);
		// The cell's first value comes from the document (its `init`), before anyone can read it.
		assert.equal(await until(again.enabled, (value) => value === true), true);
	});

	it("lets only the owner switch it; read-only guests cannot chat", async (t) => {
		const fixture = await chatModeHost();
		t.after(() => fixture.close());
		const owner = await fixture.client(OWNER).get(ChatMode, where, BACKGROUND_CONTEXT);
		const alice = await fixture.client(ALICE).get(ChatMode, where, BACKGROUND_CONTEXT);
		const bob = await fixture.client(BOB).get(ChatMode, where, BACKGROUND_CONTEXT);
		assert.equal(owner.variant, "owner");
		assert.equal(alice.variant, "reader");
		assert.equal(bob.variant, "reader");
		// A reader has no `set` and a viewer no `send`: TypeScript refuses them; called anyway, so does the provider.
		// @ts-expect-error `set` is the owner's.
		await expectChord(alice.set({ enabled: true }, BACKGROUND_CONTEXT), "invalid");
		const viewer = await fixture.client(BOB).get(Chat, where, BACKGROUND_CONTEXT);
		// @ts-expect-error `send` is a participant's.
		await expectChord(viewer.send({ text: "hi", requestId: "b" }, BACKGROUND_CONTEXT), "invalid");
		const stranger = fixture
			.client({ ...ALICE, id: "carol", home: "s2", sessions: { s2: "full" } })
			.hold(ChatMode, where, BACKGROUND_CONTEXT);
		await expectChord(whenLive(stranger), "forbidden");
	});

	it("shows a switch or a rename once the call returns: the worker follows the document, it copies nothing", async (t) => {
		const fixture = await chatModeHost();
		t.after(() => fixture.close());
		const setting = await fixture.host.get(ChatModeSetting, { conversation: 1 }, BACKGROUND_CONTEXT);
		const owner = await holdIn(fixture.client(OWNER), ChatMode, where, "owner");
		assert.equal(setting.enabled.value, false);
		await owner.set({ enabled: true }, BACKGROUND_CONTEXT);
		assert.equal(setting.enabled.value, true, "committed and followed before the answer");
		await owner.rename({ name: "Claude" }, BACKGROUND_CONTEXT);
		assert.equal(setting.name.value, "Claude");
	});

	it("lets only the owner rename the agent; mentions then use the new name", async (t) => {
		const fixture = await chatModeHost();
		t.after(() => fixture.close());
		const mode = await holdIn(fixture.client(OWNER), ChatMode, where, "owner");
		const reader = await fixture.client(ALICE).get(ChatMode, where, BACKGROUND_CONTEXT);
		const alice = await holdIn(fixture.client(ALICE), Chat, where, "participant");
		assert.equal(mode.name.value, "Pi");
		// @ts-expect-error `rename` is the owner's.
		await expectChord(reader.rename({ name: "Mallory" }, BACKGROUND_CONTEXT), "invalid");
		await expectChord(mode.rename({ name: "two words" }, BACKGROUND_CONTEXT), "invalid");
		await mode.set({ enabled: true }, BACKGROUND_CONTEXT);
		await mode.rename({ name: "Claude" }, BACKGROUND_CONTEXT);
		await until(reader.name, (name) => name === "Claude");
		// @pi is ordinary chat now; @claude asks the agent.
		await alice.send({ text: "@pi hello?", requestId: "1" }, BACKGROUND_CONTEXT);
		await until(alice.view, (view) => chatEntries(view).length === 1);
		assert(!answered(alice.view.value), "no run for @pi");
		await alice.send({ text: "@claude which place?", requestId: "2" }, BACKGROUND_CONTEXT);
		const view = await until(alice.view, answered);
		const asked = view?.entries.find((entry) => entry.kind === "chat.mention")?.data as { text?: string } | undefined;
		assert.equal(asked?.text, "@claude which place?");
	});

	it("checks a reply's target and derives what it quotes from that entry", async (t) => {
		const fixture = await chatModeHost();
		t.after(() => fixture.close());
		const owner = await holdIn(fixture.client(OWNER), Chat, where, "participant");
		const alice = await holdIn(fixture.client(ALICE), Chat, where, "participant");
		await (await holdIn(fixture.client(OWNER), ChatMode, where, "owner")).set({ enabled: true }, BACKGROUND_CONTEXT);
		const long = "should we split the tokenizer work from the parser work, or keep both in one change?";
		await owner.send({ text: long, requestId: "1" }, BACKGROUND_CONTEXT);
		const [question] = chatEntries(await until(owner.view, (view) => chatEntries(view).length === 1));

		// The client only names the entry; author and excerpt come from the entry itself.
		await alice.send({ text: "split it", requestId: "2", replyTo: question!.id }, BACKGROUND_CONTEXT);
		const reply = chatEntries(await until(owner.view, (view) => chatEntries(view).length === 2))[1];
		assert.deepEqual((reply?.data as ChatMessage).replyTo, {
			entryId: question!.id,
			author: { kind: "owner", id: "owner", name: "Owner" },
			excerpt: "should we split the tokenizer work from the parser work, or…",
		});
		// A forged quote does not even pass the contract: `replyTo` is an entry ID.
		const forged = { entryId: question!.id, author: { kind: "owner", id: "owner", name: "Owner" }, excerpt: "x" };
		await expectChord(
			alice.send({ text: "forged", requestId: "3", replyTo: forged } as never, BACKGROUND_CONTEXT),
			"invalid",
		);
		await expectChord(alice.send({ text: "unknown", requestId: "4", replyTo: 9_999 }, BACKGROUND_CONTEXT), "invalid");

		// An entry of another conversation of the same session is not found from this one.
		const context = durableContext(new AbortController().signal);
		const other = await fixture.durable.createConversation({ ownership: { kind: "ownerless" } }, context);
		const elsewhere = { session: "s1", conversation: other.id };
		await (await holdIn(fixture.client(OWNER), ChatMode, elsewhere, "owner")).set(
			{ enabled: true },
			BACKGROUND_CONTEXT,
		);
		const side = await holdIn(fixture.client(OWNER), Chat, elsewhere, "participant");
		await side.send({ text: "in another conversation", requestId: "5" }, BACKGROUND_CONTEXT);
		const [foreign] = chatEntries(await until(side.view, (view) => chatEntries(view).length === 1));
		await expectChord(
			alice.send({ text: "foreign", requestId: "6", replyTo: foreign!.id }, BACKGROUND_CONTEXT),
			"invalid",
		);

		// Pi's answers can be replied to as well, and a mention can be a reply.
		await alice.send({ text: "@pi which one is smaller?", requestId: "7" }, BACKGROUND_CONTEXT);
		const view = await until(owner.view, answered);
		const answer = view?.entries.findLast((entry) => entry.model?.[0]?.role === "assistant");
		await owner.send({ text: "thanks", requestId: "8", replyTo: answer!.id }, BACKGROUND_CONTEXT);
		const thanks = chatEntries(await until(owner.view, (next) => chatEntries(next).length === 3))[2];
		const quoted = (thanks?.data as ChatMessage).replyTo;
		assert.deepEqual(quoted?.author, { kind: "agent", id: "agent", name: "Pi" });
		assert.match(quoted?.excerpt ?? "", /^Echo: /);
		// Inputs are replyable from their data: a mention quotes what the person wrote, not the digest.
		const input = view?.entries.find((entry) => entry.kind === "chat.mention");
		await owner.send({ text: "re", requestId: "9", replyTo: input!.id }, BACKGROUND_CONTEXT);
		const re = chatEntries(await until(owner.view, (next) => chatEntries(next).length === 4))[3];
		assert.deepEqual((re?.data as ChatMessage).replyTo, {
			entryId: input!.id,
			author: { kind: "guest", id: "alice", name: "Alice" },
			excerpt: "@pi which one is smaller?",
		});
		// A mention can be a reply to a chat message: the asking line says what it answers.
		await owner.send({ text: "@pi and now?", requestId: "10", replyTo: reply!.id }, BACKGROUND_CONTEXT);
		const asked = await until(owner.view, (next) =>
			JSON.stringify(next?.entries.at(-1) ?? null).includes("replying to Alice"),
		);
		assert.match(
			JSON.stringify(asked?.entries.at(-1)?.model),
			/Owner \(replying to Alice: \\"split it\\"\) mentioned you:/,
		);
	});
});

describe("chat-mode tutorial", () => {});
