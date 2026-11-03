// Drafts: withdrawn queued input goes back to its author, once.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { DraftStore } from "../../plugins/drafts/contract.ts";
import draftsWorker from "../../plugins/drafts/worker.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Session } from "../../src/runtime/chord.ts";
import { type Fixture, holdIn, settled, startFixture, testHost, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined): LiveState | undefined =>
	view?.docs["pi.live"] as unknown as LiveState | undefined;

describe("drafts store", () => {
	it("keeps drafts per conversation and author, and hands each out once", async (t) => {
		const fixture = await testHost({ address: Session({ id: "sample" }), kind: "worker", facets: [draftsWorker] });
		t.after(() => fixture.close());
		await fixture.root(async (ctx) => {
			const store = await ctx.get(DraftStore, {});
			const alice = { kind: "guest" as const, id: "alice", name: "Alice" };
			const owner = { kind: "owner" as const, id: "owner", name: "Owner" };
			await store.add(
				{
					conversation: 1,
					items: [
						{ author: alice, text: "a1" },
						{ author: owner, text: "o1" },
						{ author: alice, text: "a2" },
					],
				},
				ctx,
			);
			await store.add({ conversation: 2, items: [{ author: alice, text: "child" }] }, ctx);
			const drafts = await settled(store.drafts);
			assert.deepEqual(
				drafts["1:alice"]?.map((item) => item.text),
				["a1", "a2"],
			);
			assert.deepEqual(
				drafts["1:owner"]?.map((item) => item.text),
				["o1"],
			);
			const ids = drafts["1:alice"]?.map((item) => item.id) ?? [];
			// Another author's claim takes nothing.
			assert.deepEqual(await store.claim({ conversation: 1, authorId: "owner", ids }, ctx), { texts: [] });
			assert.deepEqual(await store.claim({ conversation: 1, authorId: "alice", ids }, ctx), { texts: ["a1", "a2"] });
			// A second tab claiming the same drafts gets nothing.
			assert.deepEqual(await store.claim({ conversation: 1, authorId: "alice", ids }, ctx), { texts: [] });
			assert.equal(store.drafts.value?.["1:alice"], undefined);
			assert.deepEqual(
				store.drafts.value?.["2:alice"]?.map((item) => item.text),
				["child"],
			);
		});
	});
});

describe("drafts (owner, fake provider)", () => {
	let fixture: Fixture;
	let browser: Host;
	let chat: RefIn<typeof Chat, "participant">;

	before(async () => {
		fixture = await startFixture();
		browser = fixture.browser();
		const sessions = await holdIn(browser, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "drafts" }, BACKGROUND_CONTEXT);
		chat = await holdIn(browser, Chat, { session: session.id, conversation: 1 }, "participant");
	});

	after(async () => {
		await fixture?.close();
	});

	it("returns a dequeued input to its author once, and discards a removed one", async () => {
		await chat.send({ text: "slow run", requestId: "run" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => Boolean(live(view)?.run));
		const editable = await chat.send({ text: "editable", requestId: "e", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		const removed = await chat.send({ text: "removed", requestId: "r", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		assert.deepEqual(await chat.dequeue({ submissionId: editable.submissionId, restore: true }, BACKGROUND_CONTEXT), {
			text: "editable",
		});
		assert.deepEqual(
			await chat.dequeue({ submissionId: editable.submissionId, restore: true }, BACKGROUND_CONTEXT),
			{ text: null },
			"already withdrawn input is never returned twice",
		);
		assert.deepEqual(await chat.dequeue({ submissionId: removed.submissionId }, BACKGROUND_CONTEXT), { text: null });
		await chat.send({ text: "steered", requestId: "s" }, BACKGROUND_CONTEXT);
		await chat.send({ text: "followed", requestId: "f", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
		const { restored } = await chat.stop(BACKGROUND_CONTEXT);
		assert.deepEqual(restored, ["steered", "followed"]);
		await until(chat.view, (view) => !live(view)?.run);
	});
});
