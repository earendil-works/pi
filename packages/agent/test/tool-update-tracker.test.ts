import { describe, expect, it } from "vitest";
import { ToolUpdateTracker } from "../src/tool-update-tracker.ts";

describe("ToolUpdateTracker", () => {
	it("releases completed updates instead of retaining all progress events", async () => {
		const tracker = new ToolUpdateTracker();
		for (let index = 0; index < 10_000; index++) {
			tracker.track(() => Promise.resolve());
			if (index % 100 === 0) await Promise.resolve();
		}
		await tracker.drain();
		expect(tracker.pendingCount).toBe(0);
	});

	it("waits for unresolved updates and preserves asynchronous failures", async () => {
		const tracker = new ToolUpdateTracker();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		tracker.track(() => pending);
		expect(tracker.pendingCount).toBe(1);
		release();
		await tracker.drain();
		expect(tracker.pendingCount).toBe(0);

		tracker.track(() => Promise.reject(new Error("update failed")));
		await Promise.resolve();
		await expect(tracker.drain()).rejects.toThrow("update failed");
		expect(tracker.pendingCount).toBe(0);
	});
});

describe("tool update progress under slow consumers", () => {
	it("rejects promptly when one update fails while another stays pending", async () => {
		const updates = new ToolUpdateTracker();
		updates.track(() => new Promise<void>(() => {}));
		updates.track(() => Promise.reject(new Error("notification failed")));
		await expect(updates.drain()).rejects.toThrow("notification failed");
	});
	it("coalesces unawaited updates instead of accumulating thousands of blocked writes", async () => {
		const updates = new ToolUpdateTracker(2);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const delivered: number[] = [];
		for (let index = 0; index < 10_000; index++) {
			updates.track(() => {
				delivered.push(index);
				return index < 2 ? gate : undefined;
			});
		}
		expect(updates.pendingCount).toBeLessThanOrEqual(2);
		release();
		await updates.drain();
		expect(delivered.at(-1)).toBe(9_999);
		expect(delivered.length).toBeLessThan(20);
	});
});

describe("tool update cancellation", () => {
	it("does not wait for a stuck notification after tool execution rejects", async () => {
		const updates = new ToolUpdateTracker(1);
		updates.track(() => new Promise<void>(() => {}));
		const capacity = updates.track(() => Promise.resolve());
		updates.cancel();
		await capacity;
		await updates.drain();
		expect(updates.pendingCount).toBe(0);
	});
	it("does not send a coalesced update after cancellation", async () => {
		const updates = new ToolUpdateTracker(1);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const delivered: string[] = [];
		updates.track(() => { delivered.push("first"); return gate; });
		updates.track(() => { delivered.push("second"); });
		updates.cancel();
		release();
		await updates.drain();
		expect(delivered).toEqual(["first"]);
	});
});
