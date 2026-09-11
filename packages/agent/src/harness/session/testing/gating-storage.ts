import type { Context } from "../../context.ts";
import type { CommitResult, Write } from "../types.ts";
import { StorageDecorator } from "./storage-decorator.ts";

/** Thrown for every commit rejected after simulated storage loss. */
export class CommitDiscarded extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommitDiscarded";
	}
}

interface ParkedCommit {
	release(): void;
	drop(error: Error): void;
	readonly landing: Promise<void>;
}

interface PendingWaiter {
	count: number;
	resolve(): void;
	reject(error: Error): void;
}

/** Test-only storage decorator that deterministically parks admitted commits. */
export class GatingStorage extends StorageDecorator {
	private armed = false;
	private discarded = false;
	private readonly queue: ParkedCommit[] = [];
	private readonly waiters: PendingWaiter[] = [];

	/** Fixture setup bypasses gating until explicitly armed. */
	arm(): void {
		this.armed = true;
	}

	pending(): number {
		return this.queue.length;
	}

	/** Wait until at least `count` commits are parked. */
	waitPending(count = 1): Promise<void> {
		if (!Number.isSafeInteger(count) || count < 1) {
			return Promise.reject(new RangeError("Pending commit count must be a positive safe integer"));
		}
		if (this.discarded) return Promise.reject(new CommitDiscarded("storage discarded"));
		if (this.queue.length >= count) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			this.waiters.push({ count, resolve, reject });
		});
	}

	override async commit(writes: Write[], context: Context): Promise<CommitResult> {
		if (this.discarded) throw new CommitDiscarded("commit rejected: storage discarded");
		if (!this.armed) return super.commit(writes, context);

		let landed!: () => void;
		let lost!: (error: Error) => void;
		const landing = new Promise<void>((resolve, reject) => {
			landed = resolve;
			lost = reject;
		});
		void landing.catch(() => {});

		const released = new Promise<void>((resolve, reject) => {
			this.queue.push({ release: resolve, drop: reject, landing });
		});
		this.notifyWaiters();

		try {
			await released;
			if (this.discarded) throw new CommitDiscarded("commit rejected: storage discarded");
			const result = await super.commit(writes, context);
			landed();
			return result;
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			lost(normalized);
			throw error;
		}
	}

	/** Release `count` commits in FIFO order and wait until each write lands. */
	async next(count = 1): Promise<void> {
		if (!Number.isSafeInteger(count) || count < 1) {
			throw new RangeError("Released commit count must be a positive safe integer");
		}
		for (let index = 0; index < count; index++) {
			await this.waitPending();
			const parked = this.queue.shift();
			if (parked === undefined) throw new Error("No parked commit");
			parked.release();
			await parked.landing;
		}
	}

	/** Drop parked commits and permanently reject every later commit. */
	discard(): void {
		if (this.discarded) return;
		this.discarded = true;
		const error = new CommitDiscarded("commit discarded");
		for (const parked of this.queue.splice(0)) parked.drop(error);
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}

	private notifyWaiters(): void {
		for (let index = this.waiters.length - 1; index >= 0; index--) {
			const waiter = this.waiters[index]!;
			if (this.queue.length < waiter.count) continue;
			this.waiters.splice(index, 1);
			waiter.resolve();
		}
	}
}
