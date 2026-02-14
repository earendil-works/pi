import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadThreadMessagesTailFromSessionFile } from "./read-thread-session.js";

const MIN_BYTES = 256 * 1024;

describe("loadThreadMessagesTailFromSessionFile", () => {
	it("does not drop a valid first line when the tail read starts on a newline boundary", () => {
		const dir = mkdtempSync(join(tmpdir(), "read-thread-tail-"));
		const filePath = join(dir, "session.jsonl");

		const header = JSON.stringify({
			type: "session",
			id: "thread-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
			provider: "openai",
			modelId: "test",
			thinkingLevel: "off",
		});

		const prefix = `${header}\n`;

		const msg1 = JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
		});
		const msg2 = JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 },
		});

		let tail = `${msg1}\n${msg2}\n`;

		const padPrefix = '{"type":"pad","pad":"';
		const padSuffix = '"}\n';
		const remaining = MIN_BYTES - tail.length - (padPrefix.length + padSuffix.length);
		expect(remaining).toBeGreaterThan(0);
		tail += padPrefix + "x".repeat(remaining) + padSuffix;

		const content = prefix + tail;
		expect(Buffer.byteLength(content, "utf8")).toBe(MIN_BYTES + Buffer.byteLength(prefix, "utf8"));

		writeFileSync(filePath, content, "utf8");

		const loaded = loadThreadMessagesTailFromSessionFile(filePath, 10);
		expect(loaded.messages.length).toBe(2);

		const text = loaded.messages
			.map((m) =>
				typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
			)
			.join(" ");

		expect(text).toContain("first");
		expect(text).toContain("second");
	});
});
