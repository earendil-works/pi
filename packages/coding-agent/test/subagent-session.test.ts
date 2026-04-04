import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLastAssistantMessage, getEntryCount, getNewEntries } from "../examples/extensions/subagent/session.js";

describe("subagent session helpers", () => {
	let tempDir: string;
	let sessionFile: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-test-"));
		sessionFile = path.join(tempDir, "session.jsonl");
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads appended entries and returns the last assistant text summary", () => {
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					message: {
						role: "user",
						content: [{ type: "text", text: "hello" }],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "2",
					parentId: "1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "first reply" }],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "3",
					parentId: "2",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "final reply" }],
					},
				}),
				"",
			].join("\n"),
			"utf8",
		);

		expect(getEntryCount(sessionFile)).toBe(3);
		expect(findLastAssistantMessage(getNewEntries(sessionFile, 1))).toBe("final reply");
	});

	it("returns null when no assistant text blocks exist in the requested entries", () => {
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "read", arguments: {} }],
					},
				}),
				JSON.stringify({
					type: "message",
					id: "2",
					parentId: "1",
					message: {
						role: "toolResult",
						content: [{ type: "text", text: "ok" }],
					},
				}),
				"",
			].join("\n"),
			"utf8",
		);

		expect(findLastAssistantMessage(getNewEntries(sessionFile, 0))).toBeNull();
	});
});
