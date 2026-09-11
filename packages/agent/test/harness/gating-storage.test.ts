import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../../src/harness/context.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { CommitDiscarded, GatingStorage, InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type { CommitResult, Write } from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";
import { deferred } from "./runtime/test-utils.ts";

class ControlledLandingStorage extends MemoryStorage {
	readonly started = deferred();
	readonly release = deferred();

	override async commit(writes: Write[], context: Context): Promise<CommitResult> {
		this.started.resolve();
		await this.release.promise;
		return super.commit(writes, context);
	}
}

describe("GatingStorage", () => {
	it("bypasses setup writes until armed and waits for commits parked after waitPending", async () => {
		const storage = new GatingStorage(new MemoryStorage({ now: () => 10 }));
		await storage.commit([storedValues.setValue(storedValues.sessionName, "setup")], BACKGROUND_CONTEXT);
		expect(storage.pending()).toBe(0);

		storage.arm();
		let waitingResolved = false;
		const waiting = storage.waitPending().then(() => {
			waitingResolved = true;
		});
		await Promise.resolve();
		expect(waitingResolved).toBe(false);
		const commit = storage.commit([storedValues.setValue(storedValues.sessionName, "parked")], BACKGROUND_CONTEXT);
		await waiting;
		expect(storage.pending()).toBe(1);
		expect((await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("setup");

		await storage.next();
		await commit;
		expect(storage.pending()).toBe(0);
		expect((await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("parked");
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("releases in FIFO order and next resolves only after the backend write lands", async () => {
		const delegate = new ControlledLandingStorage({ now: () => 10 });
		const storage = new GatingStorage(delegate);
		storage.arm();
		const first = storage.commit([storedValues.setValue(storedValues.sessionName, "first")], BACKGROUND_CONTEXT);
		const second = storage.commit([storedValues.setValue(storedValues.sessionName, "second")], BACKGROUND_CONTEXT);
		await storage.waitPending(2);
		expect(storage.pending()).toBe(2);

		let released = false;
		const next = storage.next().then(() => {
			released = true;
		});
		await delegate.started.promise;
		await Promise.resolve();
		expect(released).toBe(false);
		expect(storage.pending()).toBe(1);
		delegate.release.resolve();
		await next;
		await first;
		expect(released).toBe(true);
		expect((await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("first");

		await storage.next();
		await second;
		expect((await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("second");
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("permanently rejects parked, waiting, and later commits after discard", async () => {
		const storage = new GatingStorage(new MemoryStorage());
		storage.arm();
		const waiting = storage.waitPending(2);
		const parked = storage.commit([storedValues.setValue(storedValues.sessionName, "lost")], BACKGROUND_CONTEXT);
		await storage.waitPending();
		expect(storage.pending()).toBe(1);

		storage.discard();
		expect(storage.pending()).toBe(0);
		await expect(parked).rejects.toBeInstanceOf(CommitDiscarded);
		await expect(waiting).rejects.toBeInstanceOf(CommitDiscarded);
		await expect(storage.next()).rejects.toBeInstanceOf(CommitDiscarded);
		await expect(storage.commit([], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(CommitDiscarded);
		await storage.close(BACKGROUND_CONTEXT);

		const unarmed = new GatingStorage(new MemoryStorage());
		unarmed.discard();
		await expect(unarmed.commit([], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(CommitDiscarded);
		await unarmed.close(BACKGROUND_CONTEXT);
	});

	it("records attempts before gating parks them", async () => {
		const gating = new GatingStorage(new MemoryStorage());
		const storage = new InstrumentedStorage(gating);
		gating.arm();
		const writes = [storedValues.setValue(storedValues.sessionName, "recorded")];

		const commit = storage.commit(writes, BACKGROUND_CONTEXT);
		expect(storage.getCommitAttempts()).toEqual([writes]);
		await gating.waitPending();
		expect(gating.pending()).toBe(1);
		await gating.next();
		await commit;
		await storage.close(BACKGROUND_CONTEXT);
	});
});
