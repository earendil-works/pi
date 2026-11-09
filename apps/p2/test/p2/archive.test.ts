// Archiving a session stops its worker for good: holders of its objects (a page's lingering conversation) wait for a
// restore instead of starting a worker the archived session refuses (a failed start with an owner notice).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import { processLogs } from "../../src/runtime/logs.ts";
import { failureOf, holdIn, settled, startFixture, until } from "./helpers.ts";

const lastAnswer = (view: ConversationView | null | undefined): string => {
	const message = view?.entries.at(-1)?.model?.[0] as AssistantMessage | undefined;
	return message?.role === "assistant"
		? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
		: "";
};

test(
	"an archived session's held objects wait for a restore; no worker starts meanwhile",
	{ timeout: 90_000 },
	async (t) => {
		const fixture = await startFixture({
			plugins: [
				"chat",
				"conversations",
				"devices",
				"drafts",
				"envs",
				"files",
				"models",
				"search",
				"sessions",
				"status",
				"subagents",
			],
		});
		t.after(() => fixture.close());
		const browser = fixture.browser();
		const sessions = await holdIn(browser, Sessions, {}, "owner");
		const status = await holdIn(browser, SessionStatus, {}, "reader");
		const { id } = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		const source = `session:${id}`;
		const starts = () => processLogs.lines(source).filter((line) => line.text.startsWith("Starting worker")).length;
		// A page's conversation, still held (lingering) when the session is archived.
		const chat = await holdIn(browser, Chat, { session: id, conversation: 1 }, "participant");
		await chat.send({ text: "hello", requestId: "r1" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => lastAnswer(view) === "Echo: hello");
		assert.equal(starts(), 1);

		await sessions.archive({ id }, BACKGROUND_CONTEXT);
		await until(status.statuses, (value) => value?.[id]?.running === false);
		const failure = await failureOf(chat);
		assert.match(failure.message, /suspended/);
		// Nothing started a worker for the held conversation, so nothing failed as archived.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.equal(starts(), 1);
		assert.equal((await settled(status.statuses))[id]?.error, undefined);
		assert.deepEqual(
			processLogs.notices().filter((notice) => notice.source === source),
			[],
		);

		// Restoring starts a worker for the waiting holder.
		await sessions.restore({ id }, BACKGROUND_CONTEXT);
		await whenLive(chat);
		await chat.send({ text: "restored", requestId: "r2" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => lastAnswer(view) === "Echo: restored");
		assert.equal(starts(), 2);
		chat.release();
	},
);
