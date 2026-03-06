import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SessionManager } from "../src/session-manager.js";

describe("oai compact session replay", () => {
	it("replays a context_compaction entry as the active in-thread history baseline", () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-oai-compact-session-"));
		const sessionFile = join(dir, "session.jsonl");
		const timestamp = new Date().toISOString();

		const replacementMessages = [
			{ role: "user", content: "Summarized compacted goal" },
			{ role: "assistant", content: "Compacted assistant checkpoint" },
		];

		const lines = [
			JSON.stringify({
				type: "session",
				version: 2,
				id: "session-1",
				timestamp,
				cwd: process.cwd(),
				provider: "openai",
				modelId: "gpt-5-mini",
				thinkingLevel: "medium",
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "Pre-compaction user message" },
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp,
				message: { role: "assistant", content: "Pre-compaction assistant reply" },
			}),
			JSON.stringify({
				type: "context_compaction",
				id: "c1",
				parentId: "m2",
				timestamp,
				replacementMessages,
			}),
			JSON.stringify({
				type: "message",
				id: "m3",
				parentId: "c1",
				timestamp,
				message: { role: "user", content: "Post-compaction follow-up" },
			}),
		].join("\n");

		writeFileSync(sessionFile, `${lines}\n`, "utf8");

		const manager = new SessionManager(false, sessionFile, true);

		expect(manager.loadMessages()).toEqual([
			...replacementMessages,
			{ role: "user", content: "Post-compaction follow-up" },
		]);
	});
});
