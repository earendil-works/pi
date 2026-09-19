import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { MemorySessionRepo } from "../../src/harness/session/index.ts";

const NOW = 1_700_000_000_000;
function uuidTimestamp(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

describe("MemorySessionRepo metadata", () => {
	it("uses its injected clock for generated session identity and metadata", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const session = await repo.create({}, BACKGROUND_CONTEXT);

		expect(session.metadata.createdAt).toBe(NOW);
		expect(uuidTimestamp(session.metadata.id)).toBe(NOW);
		await Promise.all([session.close(BACKGROUND_CONTEXT), repo.close(BACKGROUND_CONTEXT)]);
	});

	it("returns a fresh facade after close while retaining one session and storage", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const first = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
		const firstBranch = await first.createBranch("main", null, BACKGROUND_CONTEXT);
		const admittedWrite = first.setName("preserved", BACKGROUND_CONTEXT);

		await expect(repo.open(first.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already open");
		await Promise.all([admittedWrite, first.close(BACKGROUND_CONTEXT)]);
		await expect(first.getName(BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		await expect(first.scanBranch({ start: "entry" }, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		await expect(firstBranch.getTipId(BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");

		const second = await repo.open(first.metadata, BACKGROUND_CONTEXT);
		expect(second).not.toBe(first);
		expect(await second.getName(BACKGROUND_CONTEXT)).toBe("preserved");
		await second.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("waits for an explicit mutation before closing its facade", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
		const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
		let closed = false;
		const closing = session.close(BACKGROUND_CONTEXT).then(() => {
			closed = true;
		});

		await Promise.resolve();
		expect(closed).toBe(false);
		await mutation.end(BACKGROUND_CONTEXT);
		await closing;
		expect(closed).toBe(true);

		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		await Promise.all([reopened.close(BACKGROUND_CONTEXT), repo.close(BACKGROUND_CONTEXT)]);
	});

	it("rejects an explicit scope that had not acquired before facade close", async () => {
		const repo = new MemorySessionRepo({ now: () => NOW });
		const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
		const first = await session.beginMutation(BACKGROUND_CONTEXT);
		const secondPromise = session.beginMutation(BACKGROUND_CONTEXT);
		void secondPromise.catch(() => {});
		let closed = false;
		const closing = session.close(BACKGROUND_CONTEXT).then(() => {
			closed = true;
		});

		await first.end(BACKGROUND_CONTEXT);
		await expect(secondPromise).rejects.toThrow("Session is closed");
		await closing;
		expect(closed).toBe(true);

		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		await Promise.all([reopened.close(BACKGROUND_CONTEXT), repo.close(BACKGROUND_CONTEXT)]);
	});
});
