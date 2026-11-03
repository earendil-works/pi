import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { holdIn, startFixture, until } from "./helpers.ts";

describe("p2 smoke", () => {
	it("creates a session and gets an answer", async () => {
		const fixture = await startFixture();
		try {
			const browser = fixture.browser();
			const sessions = await holdIn(browser, Sessions, {}, "owner");
			const session = await sessions.create({ cwd: fixture.workspace, title: "hello" }, BACKGROUND_CONTEXT);
			const chat = await holdIn(browser, Chat, { session: session.id, conversation: 1 }, "participant");
			await chat.send({ text: "hello", requestId: "r1" }, BACKGROUND_CONTEXT);
			const view = await until(chat.view, (view) =>
				Boolean(view?.entries.some((entry) => entry.model?.[0]?.role === "assistant")),
			);
			assert.ok(view);
		} finally {
			await fixture.close();
		}
	});
});
