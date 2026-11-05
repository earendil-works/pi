// M1 acceptance with the fake provider: create a session, stream an answer, stop, reload the chat plugin while an
// answer streams, reopen after the worker stopped idle, and serve the web UI.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, statusOf } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus, StatusStore } from "../../plugins/status/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { type Fixture, failureOf, holdIn, poll, startFixture, until } from "./helpers.ts";

const assistants = (view: ConversationView | null | undefined): AssistantMessage[] =>
	(view?.entries ?? []).flatMap((entry) => {
		const message = entry.model?.[0];
		return message?.role === "assistant" ? [message as AssistantMessage] : [];
	});
const answerText = (message: AssistantMessage | undefined): string =>
	(message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
const live = (view: ConversationView | null | undefined): LiveState | undefined =>
	view?.docs["pi.live"] as unknown as LiveState | undefined;
const partial = (view: ConversationView | null | undefined): string =>
	answerText(live(view)?.generation?.message as unknown as AssistantMessage | undefined);

describe("M1: a working chat (fake provider)", () => {
	let fixture: Fixture;
	let browser: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let status: RefIn<typeof SessionStatus, "reader">;
	let sessionId: string;
	let chat: RefIn<typeof Chat, "participant">;

	before(async () => {
		fixture = await startFixture({ idleMs: 1500 });
		browser = fixture.browser();
		sessions = await holdIn(browser, Sessions, {}, "owner");
		status = await holdIn(browser, SessionStatus, {}, "reader");
	});

	after(async () => {
		await fixture?.close();
	});

	it("lists models and creates a session with the default model", async () => {
		const models = browser.hold(Models, {}, BACKGROUND_CONTEXT);
		const defaultModel = await until(models.defaultModel, (value) => Boolean(value));
		assert.equal(defaultModel?.provider, "faux");
		assert.equal(sessions.variant, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "  hello\nworld " }, BACKGROUND_CONTEXT);
		sessionId = session.id;
		assert.equal(session.title, "hello world");
		assert.deepEqual(session.model, { provider: "faux", modelId: "faux-1" });
		const listed = await until(sessions.sessions, (list) => Boolean(list?.some((s) => s.id === sessionId)));
		assert.equal(listed?.[0]?.cwd, fixture.workspace);
		await assert.rejects(sessions.create({ cwd: "relative/path" }, BACKGROUND_CONTEXT), /absolute path/);
		models.release();
	});

	it("sends a prompt and streams the answer", async () => {
		chat = await holdIn(browser, Chat, { session: sessionId, conversation: 1 }, "participant");
		const { submissionId } = await chat.send({ text: "hello", requestId: "r1" }, BACKGROUND_CONTEXT);
		// A retried request is admitted once.
		assert.equal(
			(await chat.send({ text: "hello", requestId: "r1" }, BACKGROUND_CONTEXT)).submissionId,
			submissionId,
		);
		const view = await until(chat.view, (value) => answerText(assistants(value).at(-1)) === "Echo: hello");
		assert.equal(assistants(view).length, 1);
		const running = await until(status.statuses, (value) => value?.[sessionId]?.running === true);
		assert.equal(running?.[sessionId]?.running, true);
	});

	it("lets the agent rename its session (a Durable tool calling the server)", async () => {
		await chat.send({ text: "rename-session Greeting the agent", requestId: "rename" }, BACKGROUND_CONTEXT);
		const list = await until(sessions.sessions, (value) =>
			Boolean(value?.some((s) => s.id === sessionId && s.title === "Greeting the agent")),
		);
		assert.ok(list);
		await until(chat.view, (value) => !live(value)?.run && answerText(assistants(value).at(-1)).startsWith("Echo"));
	});

	it("configures the model of the session", async () => {
		await chat.configure(
			{ model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" },
			BACKGROUND_CONTEXT,
		);
		await until(
			chat.view,
			(value) => (value?.docs["pi.agent"] as { thinkingLevel?: string })?.thinkingLevel === "off",
		);
		await assert.rejects(
			chat.configure({ model: { provider: "faux", modelId: "missing" } }, BACKGROUND_CONTEXT),
			/Unknown model/,
		);
	});

	it("streams partial text, shows the session busy, and stops", async () => {
		await chat.send({ text: "slow one", requestId: "r2" }, BACKGROUND_CONTEXT);
		// Send pushes the worker's status before it answers: the server's index shows the session busy already.
		const store = await fixture.server.host.get(StatusStore, {}, BACKGROUND_CONTEXT);
		assert(store.statuses.value[sessionId]?.busy.includes(1));
		await until(chat.view, (value) => partial(value).length > 20);
		await until(status.statuses, (value) => value?.[sessionId]?.busy.includes(1) === true);
		// A follow-up queued behind the run comes back to its author when stopping.
		await chat.send({ text: "queued later", requestId: "r3", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		const { restored } = await chat.stop(BACKGROUND_CONTEXT);
		assert.deepEqual(restored, ["queued later"]);
		assert.deepEqual(store.statuses.value[sessionId]?.busy, [], "stop pushes the idle status before it answers");
		const view = await until(
			chat.view,
			(value) => !live(value)?.run && assistants(value).at(-1)?.stopReason === "aborted",
		);
		assert.equal(assistants(view).at(-1)?.stopReason, "aborted");
		await until(status.statuses, (value) => value?.[sessionId]?.busy.length === 0);
	});

	it("keeps streaming through a compatible reload of the chat plugin", async () => {
		await chat.send({ text: "slow two", requestId: "r4" }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) => partial(value).length > 20);
		const before = partial(chat.view.value);
		const report = await fixture.server.reload(["chat"]);
		assert.equal(report.stopped, undefined);
		// The stream continues after the reload: partials grow, then the full answer commits.
		await until(chat.view, (value) => partial(value).length > before.length + 40);
		const view = await until(
			chat.view,
			(value) => !live(value)?.run && answerText(assistants(value).at(-1)).startsWith("Echo: slow two"),
			30_000,
		);
		const answer = assistants(view).at(-1);
		assert.equal(answer?.stopReason, "stop");
		assert.equal(answerText(answer), `Echo: slow two ${"streaming ".repeat(300)}`);
		// Calls after the reload run on the new code.
		await chat.send({ text: "after reload", requestId: "r5" }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) => answerText(assistants(value).at(-1)) === "Echo: after reload");
	});

	it("stops the worker when idle and reopens the session from its storage", async () => {
		chat.release();
		// The released Chat lingers 30 s on the worker, which keeps it alive (Chord's activity counts lingering objects).
		await until(status.statuses, (value) => value?.[sessionId]?.running === false, 60_000);
		chat = await holdIn(browser, Chat, { session: sessionId, conversation: 1 }, "participant");
		const view = await until(chat.view, (value) => assistants(value).length >= 6);
		assert.equal(answerText(assistants(view)[0]), "Echo: hello");
		// The new worker started on the epoch before the reload and was reconciled; its status reports still arrive.
		await chat.send({ text: "slow reopened", requestId: "r6" }, BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[sessionId]?.busy.includes(1) === true);
		await until(chat.view, (value) => answerText(assistants(value).at(-1)).startsWith("Echo: slow reopened"), 30_000);
		await until(status.statuses, (value) => value?.[sessionId]?.busy.length === 0);
	});

	it("archives (stopping the worker) and restores", async () => {
		await sessions.archive({ id: sessionId }, BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[sessionId]?.running === false, 30_000);
		const archived = await until(sessions.sessions, (list) =>
			Boolean(list?.find((s) => s.id === sessionId)?.archivedAt),
		);
		assert.ok(archived);
		chat.release();
		// An archived session's worker does not start.
		const refused = browser.hold(Chat, { session: sessionId, conversation: 1 }, BACKGROUND_CONTEXT);
		await failureOf(refused);
		refused.release();
		await sessions.restore({ id: sessionId }, BACKGROUND_CONTEXT);
		chat = await holdIn(browser, Chat, { session: sessionId, conversation: 1 }, "participant");
		await until(chat.view, (value) => assistants(value).length >= 7);
		await poll(() => statusOf(chat) === "live", 5000, "live chat");
	});
});
