import { existsSync, type FSWatcher, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsWatcher } from "../src/events.js";
import type { SlackBot, SlackEvent } from "../src/slack.js";

describe("EventsWatcher fs.watch error handling", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mom-events-"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("retries the events fs watcher 5 seconds after an async error", async () => {
		vi.useFakeTimers();
		const slack = {
			enqueueEvent: vi.fn((_event: SlackEvent) => true),
		} as unknown as SlackBot;
		const eventsDir = join(tempDir, "events");
		const watcher = new EventsWatcher(eventsDir, slack);

		try {
			watcher.start();
			const watcherWithInternals = watcher as unknown as { watcher: FSWatcher | null };
			const originalWatcher = watcherWithInternals.watcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(watcherWithInternals.watcher).toBeNull();

			await vi.advanceTimersByTimeAsync(4999);
			expect(watcherWithInternals.watcher).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(watcherWithInternals.watcher).not.toBeNull();
			expect(watcherWithInternals.watcher).not.toBe(originalWatcher);
		} finally {
			watcher.stop();
			vi.useRealTimers();
		}
	});
});
