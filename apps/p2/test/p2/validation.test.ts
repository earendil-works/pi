// Request validation as Pi Mobile does it: unknown models, thinking levels outside off…max, blank messages; a single
// configured field still updates the session's catalog entry.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { expectChord, type Fixture, holdIn, startFixture, until } from "./helpers.ts";

describe("validation (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let sessions: RefIn<typeof Sessions, "owner">;
	let session: Session;
	let chat: RefIn<typeof Chat, "participant">;
	before(async () => {
		fixture = await startFixture();
		owner = fixture.browser();
		sessions = await holdIn(owner, Sessions, {}, "owner");
		session = await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT);
		chat = await holdIn(owner, Chat, { session: session.id, conversation: 1 }, "participant");
	});
	after(async () => {
		await fixture?.close();
	});

	it("refuses unknown models and thinking levels when creating", async () => {
		await assert.rejects(
			sessions.create(
				{ cwd: fixture.workspace, model: { provider: "faux", modelId: "missing" } },
				BACKGROUND_CONTEXT,
			),
			/Unknown model/,
		);
		await expectChord(
			sessions.create({ cwd: fixture.workspace, thinkingLevel: "extreme" }, BACKGROUND_CONTEXT),
			"invalid",
		);
		const created = await sessions.create({ cwd: fixture.workspace, thinkingLevel: "low" }, BACKGROUND_CONTEXT);
		assert.equal(created.thinkingLevel, "low");
	});

	it("refuses a blank message without attachments", async () => {
		await assert.rejects(chat.send({ text: "  \n ", requestId: "blank" }, BACKGROUND_CONTEXT), /Invalid content/);
		await assert.rejects(chat.send({ text: "", requestId: "empty" }, BACKGROUND_CONTEXT), /Invalid content/);
	});

	it("refuses unknown thinking levels and updates the catalog from a single field", async () => {
		await expectChord(chat.configure({ thinkingLevel: "extreme" }, BACKGROUND_CONTEXT), "invalid");
		await chat.configure({ thinkingLevel: "minimal" }, BACKGROUND_CONTEXT);
		await until(sessions.sessions, (list) => list?.find((s) => s.id === session.id)?.thinkingLevel === "minimal");
		await chat.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
		const list = await until(sessions.sessions, (value) => Boolean(value?.find((s) => s.id === session.id)));
		assert.equal(list?.find((s) => s.id === session.id)?.thinkingLevel, "minimal", "the other field keeps its value");
	});
});
