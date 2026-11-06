import { describe, expect, it } from "vitest";
import { PendingMessageQueue } from "../src/pending-message-queue.ts";

describe("PendingMessageQueue", () => {
	it("drains thousands of one-at-a-time messages in FIFO order", () => {
		const queue = new PendingMessageQueue<{ id: number }>("one-at-a-time");
		for (let index = 0; index < 10_000; index++) queue.enqueue({ id: index });
		for (let index = 0; index < 10_000; index++) {
			expect(queue.drain()).toEqual([{ id: index }]);
		}
		expect(queue.hasItems()).toBe(false);
		expect(queue.drain()).toEqual([]);
	});

	it("preserves the remaining queue when switching from one to all", () => {
		const queue = new PendingMessageQueue<{ id: number }>("one-at-a-time");
		queue.enqueue({ id: 1 });
		queue.enqueue({ id: 2 });
		expect(queue.peek()).toEqual([{ id: 1 }]);
		expect(queue.drain()).toEqual([{ id: 1 }]);
		queue.mode = "all";
		queue.enqueue({ id: 3 });
		expect(queue.peek()).toEqual([{ id: 2 }, { id: 3 }]);
		expect(queue.drain()).toEqual([{ id: 2 }, { id: 3 }]);
		expect(queue.hasItems()).toBe(false);
		queue.enqueue({ id: 4 });
		queue.clear();
		expect(queue.peek()).toEqual([]);
	});
});
