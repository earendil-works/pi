// Prompt resources: the app guide, global and project AGENTS.md and skills reach the model, and edits apply live.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { CHAT_PARTICIPANT, Chat, type ChatParticipant } from "../../plugins/chat/contract.ts";
import { SESSIONS_OWNER, SessionLock, Sessions } from "../../plugins/sessions/contract.ts";
import { type Fixture, holdWith, startFixture, until } from "./helpers.ts";

/** The system sections in effect: the latest value of each, replayed from `pi.system` entries. */
function sections(view: ConversationView | null | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of view?.entries ?? []) {
		for (const message of entry.model ?? []) {
			if (message.role !== "system") continue;
			for (const [key, value] of Object.entries(
				(message as { sections?: Record<string, string | null> }).sections ?? {},
			)) {
				if (value === null) delete result[key];
				else result[key] = value;
			}
		}
	}
	return result;
}

describe("prompt resources (fake provider)", () => {
	let fixture: Fixture;
	let chat: ChatParticipant;
	let session: string;

	before(async () => {
		fixture = await startFixture();
		await mkdir(fixture.dataDir, { recursive: true });
		await writeFile(join(fixture.dataDir, "AGENTS.md"), "Global rule: be brief.");
		await writeFile(join(fixture.workspace, "AGENTS.md"), "Project rule: use tabs.");
		await mkdir(join(fixture.dataDir, "skills", "deploy"), { recursive: true });
		await writeFile(
			join(fixture.dataDir, "skills", "deploy", "SKILL.md"),
			"---\nname: deploy\ndescription: Deploys the app.\n---\nRun the deploy script.",
		);
		const owner = fixture.browser();
		session = (
			await (
				await holdWith(owner, Sessions, {}, ...SESSIONS_OWNER)
			).create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)
		).id;
		chat = await holdWith(owner, Chat, { session, conversation: 1 }, ...CHAT_PARTICIPANT);
	});

	after(async () => {
		await fixture?.close();
	});

	it("puts the app guide, instructions and skills into the system prompt", async () => {
		await chat.send({ text: "hello", requestId: "1" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => Boolean(sections(value)["agents-md"]));
		const prompt = sections(view);
		assert.match(prompt.app ?? "", /running inside Pi \(p2/);
		assert.match(prompt.app ?? "", new RegExp(fixture.dataDir.replaceAll("/", "\\/")));
		assert.match(prompt["agents-md"] ?? "", /Global rule: be brief\.[\s\S]*Project rule: use tabs\./);
		assert.match(prompt.skills ?? "", /<name>deploy<\/name><description>Deploys the app\.<\/description>/);
		assert.match(prompt.preamble ?? "", /coding assistant/);
	});

	it("applies edits without restarting the worker", async () => {
		await writeFile(join(fixture.workspace, "AGENTS.md"), "Project rule: use spaces.");
		// The watch reloads; the next generation renders the new text.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await chat.send({ text: "again", requestId: "2" }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) => /use spaces/.test(sections(value)["agents-md"] ?? ""));
	});

	it("leaves the owner's global instructions and skills out of a locked session that did not pick them", async () => {
		const locks = await holdWith(fixture.browser(), SessionLock, {}, "locks", "set");
		await locks.set(
			{ session, lock: { mcp: [], projectMcp: false, instructions: false, capabilities: [] } },
			BACKGROUND_CONTEXT,
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		await chat.send({ text: "locked", requestId: "3" }, BACKGROUND_CONTEXT);
		const view = await until(chat.view, (value) => !/Global rule/.test(sections(value)["agents-md"] ?? "x"));
		const prompt = sections(view);
		assert.match(prompt["agents-md"] ?? "", /Project rule/);
		assert.doesNotMatch(prompt.skills ?? "", /deploy/);
		await locks.set({ session, lock: null }, BACKGROUND_CONTEXT);
	});
});
