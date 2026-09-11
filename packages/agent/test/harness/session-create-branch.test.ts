import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { insertEntry } from "../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import {
	SessionBranchExistsError,
	SessionInvalidBranchError,
	SessionUnknownTargetError,
	StorageBackedSession,
} from "../../src/harness/session/session.ts";
import { branchTip, laneConfig, laneState } from "../../src/harness/session/values.ts";

function createSession(): StorageBackedSession {
	return new StorageBackedSession(
		{ id: "session", createdAt: 1, storageVersion: 1 },
		new MemoryStorage({ now: () => 10 }),
	);
}

describe("Session.createBranch", () => {
	it("creates only the data Branch at a validated target", async () => {
		const session = createSession();
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						insertEntry({
							id: "target",
							parentId: null,
							type: "custom",
							customType: "target",
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		const branch = await session.createBranch("main", "target", BACKGROUND_CONTEXT);
		expect(await branch.getTipId(BACKGROUND_CONTEXT)).toBe("target");
		expect((await session.getValue(branchTip("main"), BACKGROUND_CONTEXT))?.value).toBe("target");
		expect(await session.getValue(laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(laneState("main"), BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("validates names and non-null targets", async () => {
		const session = createSession();
		await expect(session.createBranch("", null, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			SessionInvalidBranchError,
		);
		await expect(session.createBranch("bad\u0000name", null, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			SessionInvalidBranchError,
		);
		await expect(session.createBranch("main", "missing", BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			SessionUnknownTargetError,
		);
		expect(await session.branch("main", BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("rejects duplicates atomically, including concurrent creation", async () => {
		const session = createSession();
		const results = await Promise.allSettled([
			session.createBranch("main", null, BACKGROUND_CONTEXT),
			session.createBranch("main", null, BACKGROUND_CONTEXT),
		]);
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		const rejected = results.find(({ status }) => status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: expect.any(SessionBranchExistsError),
		});
		expect(await session.branch("main", BACKGROUND_CONTEXT)).toBeDefined();
		await session.close(BACKGROUND_CONTEXT);
	});
});
