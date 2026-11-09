// The Familiar (plugins/familiar): made once on first open, restored when archived; its worker sets its main
// conversation's tools and adds its prompt section, other sessions keep theirs; it compacts once its cache is cold and
// its context large (cold.ts), without new input, and other sessions do not.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentState, ContextView, ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { coldAt, coldThreshold, lastAnswer } from "../../plugins/familiar/cold.ts";
import { FAMILIAR_TITLE, Familiar } from "../../plugins/familiar/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

const agentOf = (view: ConversationView | null | undefined) => view?.docs["pi.agent"] as AgentState | undefined;

/** The prompt sections in effect at the end of a conversation's view: its system messages replayed in order. */
function sections(view: ConversationView | null | undefined): Record<string, string> {
	const current: Record<string, string> = {};
	for (const entry of view?.entries ?? [])
		for (const message of entry.model ?? []) {
			if (message.role !== "system") continue;
			for (const [key, value] of Object.entries(message.sections ?? {})) {
				if (value === null) delete current[key];
				else current[key] = value;
			}
		}
	return current;
}

describe("the Familiar session", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let familiar: RefIn<typeof Familiar, "owner">;
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		familiar = await holdIn(owner, Familiar, {}, "owner");
	});
	after(async () => {
		await fixture?.close();
	});

	it("is made once on first open, in the home directory, and restored when archived", async () => {
		assert.equal(await until(familiar.session, (value) => value !== undefined), null);
		const [first, second] = await Promise.all([familiar.open(BACKGROUND_CONTEXT), familiar.open(BACKGROUND_CONTEXT)]);
		assert.equal(first.id, second.id, "concurrent opens make one session");
		assert.equal(await until(familiar.session, (value) => value === first.id), first.id);
		const rows = await until(sessions.sessions, (list) => Boolean(list?.some((row) => row.id === first.id)));
		assert.equal(rows?.filter((row) => row.title === FAMILIAR_TITLE).length, 1);
		assert.equal(rows?.find((row) => row.id === first.id)?.cwd, homedir());
		await sessions.archive({ id: first.id }, BACKGROUND_CONTEXT);
		assert.equal((await familiar.open(BACKGROUND_CONTEXT)).id, first.id);
		await until(sessions.sessions, (list) => list?.find((row) => row.id === first.id)?.archivedAt === null);
	});

	it("offers only its tools and has its prompt; other sessions keep theirs", async () => {
		const { id } = await familiar.open(BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		const agent = agentOf(await until(chat.view, (view) => Array.isArray(agentOf(view)?.modelTools)));
		assert.deepEqual(agent?.modelTools, [
			"conversations",
			"codemode",
			"history_search",
			"history_read",
			"history_handoff",
		]);
		assert.deepEqual(agent?.tools, [
			"conversations",
			"codemode",
			"history_search",
			"history_read",
			"history_handoff",
			"agent",
			"bash",
			"read",
		]);
		assert.equal(agent?.compaction, undefined, "only the regular compaction cutoff while its cache is warm");
		await chat.send({ text: "hello familiar", requestId: "hello" }, BACKGROUND_CONTEXT);
		const answered = await until(chat.view, (view) => JSON.stringify(view).includes("Echo: hello familiar"));
		assert.match(sections(answered).familiar ?? "", /Familiar/);
		chat.release();

		const other = (await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT)).id;
		const otherChat = await holdIn(owner, Chat, { session: other, conversation: 1 }, "participant");
		await otherChat.send({ text: "hello other", requestId: "other" }, BACKGROUND_CONTEXT);
		const view = await until(otherChat.view, (value) => JSON.stringify(value).includes("Echo: hello other"));
		assert.equal(agentOf(view)?.tools, undefined);
		assert.equal(sections(view).familiar, undefined);
		otherChat.release();
	});
});

describe("cold compaction", () => {
	it("compacts from 150k, or the regular cutoff when lower, once the cache and its warming are over", () => {
		assert.equal(coldThreshold(1_000_000, 16_384), 150_000);
		assert.equal(coldThreshold(128_000, 16_384), 111_616);
		assert.equal(coldAt(1_000, 300_000, 1_800_000), 2_101_000);
	});

	it("takes the newest answer after the context's head only", () => {
		const answer = (id: number, totalTokens: number) => ({
			entry: { id } as EntryRecord,
			message: {
				role: "assistant",
				content: [],
				usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens },
			} as unknown as AssistantMessage,
		});
		const user = {
			entry: { id: 3 } as EntryRecord,
			message: { role: "user", content: "x", timestamp: 1 } as Message,
		};
		const view = (head: number | undefined, items: { entry: EntryRecord; message: Message }[]) =>
			({
				head: head === undefined ? undefined : ({ id: head } as EntryRecord),
				entries: items.map((item) => item.entry),
				contributions: items.map((item) => [item.message]),
				messages: items.map((item) => item.message),
			}) as ContextView;
		assert.equal(lastAnswer(view(undefined, [answer(1, 10), answer(2, 20), user]))?.tokens, 20);
		// A compaction (head 5) after the answers: nothing to compact again until a new answer.
		assert.equal(lastAnswer(view(5, [answer(1, 10), answer(2, 20), user])), undefined);
		assert.equal(lastAnswer(view(5, [answer(2, 20), answer(6, 30)]))?.tokens, 30);
	});
});

describe("the Familiar once cold", () => {
	it("compacts a large context after its answer, without new input; other sessions do not", async (t) => {
		const fixture = await startFixture();
		t.after(() => fixture.close());
		// The faux model has no prompt cache: an answer is cold at once. A regular cutoff of 2k (below every request
		// here) is the Familiar's threshold; keeping 1 token leaves something to compact.
		writeFileSync(
			join(fixture.dataDir, "settings.json"),
			JSON.stringify({ compaction: { reserveTokens: 126_000, keepRecentTokens: 1, backgroundTokens: 0 } }),
		);
		const owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		const familiar = await holdIn(owner, Familiar, {}, "owner");
		const compacted = (view: ConversationView | null | undefined) =>
			(view?.entries ?? []).some((entry) => entry.kind === "pi.compaction");
		const { id } = await familiar.open(BACKGROUND_CONTEXT);
		const chat = await holdIn(owner, Chat, { session: id, conversation: 1 }, "participant");
		await chat.send({ text: "a first question", requestId: "first" }, BACKGROUND_CONTEXT);
		await until(chat.view, compacted, 60_000);
		chat.release();

		const other = (await sessions.create({ cwd: fixture.workspace, title: "Other" }, BACKGROUND_CONTEXT)).id;
		const otherChat = await holdIn(owner, Chat, { session: other, conversation: 1 }, "participant");
		await otherChat.send({ text: "a first question", requestId: "first" }, BACKGROUND_CONTEXT);
		await until(otherChat.view, (view) => JSON.stringify(view).includes("Echo: a first question"));
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		assert.equal(compacted(await until(otherChat.view, Boolean)), false);
		otherChat.release();
	});
});
