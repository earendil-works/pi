import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { filterSessionsByRegexInWorker } from "../src/modes/interactive/components/session-selector-regex-worker.ts";

function session(id: string, allMessagesText: string, name?: string, modified = 0): SessionInfo {
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		name,
		created: new Date(0),
		modified: new Date(modified),
		messageCount: 1,
		firstMessage: allMessagesText.slice(0, 100),
		allMessagesText,
	};
}

describe("isolated session regex search", () => {
	it("preserves word-boundary and case-insensitive matching", async () => {
		const items = [session("one", "Brave is great"), session("two", "bravery is not the same")];
		const result = await filterSessionsByRegexInWorker(items, "\\bbrave\\b", "recent");
		expect(result.map((item) => item.id)).toEqual(["one"]);
	});

	it("ranks session names above message text and breaks ties by recent activity", async () => {
		const items = [
			session("a", "brave", undefined, 50),
			session("b", "unrelated", "Brave work", 10),
			session("c", "brave", undefined, 100),
		];
		const result = await filterSessionsByRegexInWorker(items, "brave", "relevance");
		expect(result.map((item) => item.id)).toEqual(["b", "c", "a"]);
	});

	it("keeps the main event loop responsive and terminates catastrophic backtracking", async () => {
		const items = [session("catastrophic", "a".repeat(20_000) + "!")];
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		try {
			await expect(filterSessionsByRegexInWorker(items, "^(a|aa)+$", "recent")).rejects.toThrow(
				/regex search timed out/i,
			);
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThan(5);
	});

	it("cancels a search before starting work", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(filterSessionsByRegexInWorker([session("one", "x")], "x", "recent", controller.signal))
			.rejects.toThrow(/cancelled/i);
	});

	it("cancels a catastrophic regex after execution begins without blocking the event loop", async () => {
		const controller = new AbortController();
		const pending = filterSessionsByRegexInWorker(
			[session("catastrophic", "a".repeat(20_000) + "!")],
			"^(a|aa)+$",
			"recent",
			controller.signal,
		);
		setTimeout(() => controller.abort(), 50);
		await expect(pending).rejects.toThrow(/cancelled/i);
	});

	it("searches large history from the JSONL file on the worker, including matches across messages", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-regex-large-session-"));
		try {
			const path = join(directory, "large.jsonl");
			const first = "x".repeat(150_000) + "needle";
			writeFileSync(path, [
				JSON.stringify({ type: "session", version: 3, id: "large", cwd: directory, timestamp: "2026-01-01T00:00:00Z" }),
				JSON.stringify({ type: "message", id: "1", message: { role: "user", content: first }, timestamp: "2026-01-01T00:00:01Z" }),
				JSON.stringify({ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "next" }] }, timestamp: "2026-01-01T00:00:02Z" }),
			].join("\n") + "\n");
			const item = { ...session("large", first + " next"), path, cwd: directory };
			const result = await filterSessionsByRegexInWorker([item], "needle next$", "recent");
			expect(result.map((value) => value.id)).toEqual(["large"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves recent order across worker batches", async () => {
		const items = Array.from({ length: 51 }, (_, index) =>
			session(`s${index}`, index % 3 === 0 ? "match" : "miss"),
		);
		const result = await filterSessionsByRegexInWorker(items, "match", "recent");
		expect(result.map((item) => item.id)).toEqual(items.filter((_, index) => index % 3 === 0).map((item) => item.id));
	});

	it("reports an invalid expression without blocking the picker", async () => {
		await expect(filterSessionsByRegexInWorker([session("one", "x")], "(", "recent")).rejects.toThrow();
	});
});
