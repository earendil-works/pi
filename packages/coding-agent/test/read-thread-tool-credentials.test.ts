import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model, TextContent } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function isTextContent(value: unknown): value is TextContent {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value)) return false;
	if (!("text" in value)) return false;
	const v = value as { type: unknown; text: unknown };
	return v.type === "text" && typeof v.text === "string";
}

// Force getApiKeyForModel() to throw to simulate OAuth enforcement failures.
vi.mock("../src/model-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/model-config.js")>();
	return {
		...actual,
		getApiKeyForModel: vi.fn(async () => {
			throw new Error("OAuth token required");
		}),
	};
});

// Also mock completeSimple to ensure we don't hit the network if something changes.
vi.mock("@kennyfrc/mu-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@kennyfrc/mu-ai")>();
	return { ...actual, completeSimple: vi.fn() };
});

import { getCurrentModel, setCurrentModel } from "../src/runtime-state.js";
import { readThreadTool } from "../src/tools/read-thread.js";

function toWorkspaceDirName(cwd: string): string {
	return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

describe("readThreadTool (extraction mode) credential failure fallback", () => {
	const origCwd = process.cwd();
	const origMuDir = process.env.MU_CODING_AGENT_DIR;
	const previousModel = getCurrentModel();

	let testRoot: string;
	let testProject: string;

	beforeEach(() => {
		testRoot = mkdtempSync(join(tmpdir(), "read-thread-creds-"));
		testProject = join(testRoot, "project");
		mkdirSync(testProject, { recursive: true });
		process.chdir(testProject);

		process.env.MU_CODING_AGENT_DIR = testRoot;

		const sessionsRoot = join(resolve(testRoot), "sessions");
		const wsDir = join(sessionsRoot, toWorkspaceDirName(testProject));
		mkdirSync(wsDir, { recursive: true });

		const threadId = "thread-cred-123";
		const sessionPath = join(wsDir, `2026-01-01_${threadId}.jsonl`);
		const lines: string[] = [];
		lines.push(
			JSON.stringify({ type: "session", id: threadId, timestamp: "2026-01-01T00:00:00.000Z", cwd: testProject }),
		);
		for (let i = 0; i < 10; i++) {
			lines.push(
				JSON.stringify({
					type: "message",
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: `m${i}` }], timestamp: i },
				}),
			);
		}
		writeFileSync(sessionPath, lines.join("\n"), "utf8");

		const model: Model<"openai-completions"> = {
			id: "test",
			name: "test",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		setCurrentModel(model);
	});

	afterEach(() => {
		process.chdir(origCwd);
		if (origMuDir === undefined) delete process.env.MU_CODING_AGENT_DIR;
		else process.env.MU_CODING_AGENT_DIR = origMuDir;

		if (previousModel) setCurrentModel(previousModel);
	});

	it("returns raw <reference_thread> with a warning when credential resolution throws", async () => {
		const result = await readThreadTool.execute("call-1", {
			id: "thread-cred-123",
			goal: "What are the last messages?",
			max_messages: 5,
		});

		const text = result.content
			.filter(isTextContent)
			.map((c) => c.text)
			.join("");

		expect(text).toContain("<reference_thread");
		expect(text).toContain("<warning>Extraction credentials unavailable:");
		// Tail window should still apply for the raw fallback.
		expect(text).toContain("m5");
		expect(text).toContain("m9");
		expect(text).not.toContain("m0");
	});
});
