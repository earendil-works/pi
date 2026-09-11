import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { insertEntry } from "../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { SessionPendingAssistantMessageError, StorageBackedSession } from "../../src/harness/session/session.ts";
import { branchTip, setValue } from "../../src/harness/session/values.ts";

function createSession(): StorageBackedSession {
	return new StorageBackedSession(
		{ id: "session", createdAt: 1, storageVersion: 1 },
		new MemoryStorage({ now: () => 10 }),
		{ idGenerator: { next: () => `entry-${nextId++}` } },
	);
}

let nextId = 1;

describe("Branch", () => {
	it("is absent until explicitly created and Session has no implicit Branch surface", async () => {
		const session = createSession();
		expect(await session.branch("main", BACKGROUND_CONTEXT)).toBeUndefined();
		expect("getTipId" in session).toBe(false);
		expect("appendMessage" in session).toBe(false);
		expect("findEntriesOnBranch" in session).toBe(false);

		const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
		expect(branch.name).toBe("main");
		expect(await branch.getTipId(BACKGROUND_CONTEXT)).toBeNull();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("directly appends immutable entries and advances only its own tip", async () => {
		nextId = 1;
		const session = createSession();
		const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
		const review = await session.createBranch("review", null, BACKGROUND_CONTEXT);
		const message = { role: "user" as const, content: "hello", timestamp: 1 };

		const messageId = await main.appendMessage(message, BACKGROUND_CONTEXT);
		const customId = await main.appendCustomEntry("note", { ok: true }, BACKGROUND_CONTEXT);
		const reviewId = await review.appendCustomEntry("review", undefined, BACKGROUND_CONTEXT);

		expect(await main.getTipId(BACKGROUND_CONTEXT)).toBe(customId);
		expect(await review.getTipId(BACKGROUND_CONTEXT)).toBe(reviewId);
		expect((await main.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
			messageId,
			customId,
		]);
		expect(await main.findEntry({ type: "message" }, BACKGROUND_CONTEXT)).toMatchObject({
			id: messageId,
			type: "message",
			message,
		});
		await session.close(BACKGROUND_CONTEXT);
	});

	it("supports explicit starts without moving the Branch tip", async () => {
		const session = createSession();
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
						insertEntry({ id: "left", parentId: "root", type: "custom", customType: "left" }),
						insertEntry({ id: "right", parentId: "root", type: "custom", customType: "right" }),
						setValue(branchTip("main"), "left"),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const branch = await session.branch("main", BACKGROUND_CONTEXT);
		if (branch === undefined) throw new Error("Expected main Branch");

		expect(
			(await branch.findEntries({ start: "right", order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
		).toEqual(["root", "right"]);
		expect(await branch.getTipId(BACKGROUND_CONTEXT)).toBe("left");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("rejects pending assistant messages before committing", async () => {
		const session = createSession();
		const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
		await expect(
			branch.appendMessage(
				{
					role: "assistant",
					content: [],
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "pending",
					timestamp: 1,
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toBeInstanceOf(SessionPendingAssistantMessageError);
		expect(await branch.getTipId(BACKGROUND_CONTEXT)).toBeNull();
		await session.close(BACKGROUND_CONTEXT);
	});
});
