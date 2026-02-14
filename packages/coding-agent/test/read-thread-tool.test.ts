import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context, Message, TextContent } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function isTextContent(value: unknown): value is TextContent {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value)) return false;
	if (!("text" in value)) return false;
	const v = value as { type: unknown; text: unknown };
	return v.type === "text" && typeof v.text === "string";
}

// Mock completeSimple before importing the tool module (ESM).
vi.mock("@kennyfrc/mu-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@kennyfrc/mu-ai")>();

	return {
		...actual,
		completeSimple: vi.fn(async (_model: unknown, context: Context) => {
			const text = context.messages
				.flatMap((m: Message): unknown[] => {
					if (m.role === "assistant") return m.content;
					if (m.role === "user") return typeof m.content === "string" ? [] : m.content;
					return m.content;
				})
				.filter(isTextContent)
				.map((c) => c.text)
				.join("\n");

			// Extraction mode defaults to a tail window when start_index is omitted.
			expect(text).toContain("m5");
			expect(text).toContain("m9");
			expect(text).not.toContain("m0");

			return {
				role: "assistant",
				content: [{ type: "text", text: "<analysis>OK</analysis>" }],
				api: "openai-completions",
				provider: "openai",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		}),
	};
});

import type { Model } from "@kennyfrc/mu-ai";

import { getCurrentModel, setCurrentModel } from "../src/runtime-state.js";
import { readThreadTool } from "../src/tools/read-thread.js";

function toWorkspaceDirName(cwd: string): string {
	return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

describe("readThreadTool (extraction mode)", () => {
	const origCwd = process.cwd();
	const origMuDir = process.env.MU_CODING_AGENT_DIR;
	const origOpenAiKey = process.env.OPENAI_API_KEY;
	const previousModel = getCurrentModel();

	let testRoot: string;
	let testProject: string;
	let sessionsRoot: string;

	beforeEach(() => {
		testRoot = mkdtempSync(join(tmpdir(), "read-thread-tool-"));
		testProject = join(testRoot, "project");
		mkdirSync(testProject, { recursive: true });
		process.chdir(testProject);

		process.env.MU_CODING_AGENT_DIR = testRoot;
		process.env.OPENAI_API_KEY = "test-key";

		sessionsRoot = join(resolve(testRoot), "sessions");
		const wsDir = join(sessionsRoot, toWorkspaceDirName(testProject));
		mkdirSync(wsDir, { recursive: true });

		const threadId = "thread-123";
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
		if (origOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = origOpenAiKey;

		if (previousModel) {
			setCurrentModel(previousModel);
		}
	});

	it("defaults extraction mode window to the tail and returns <thread_extract>", async () => {
		const result = await readThreadTool.execute("call-1", {
			id: "thread-123",
			goal: "What are the last messages?",
			max_messages: 5,
		});

		const text = result.content
			.filter(isTextContent)
			.map((c: TextContent) => c.text)
			.join("");

		expect(text).toContain("<thread_extract>");
		expect(text).toContain("<source_thread>thread-123</source_thread>");
		expect(text).toContain("<goal>");
		expect(text).toContain("What are the last messages?");
		expect(text).toContain("</goal>");
		expect(text).toContain("<extract>");
		expect(text).toContain("OK");

		// Goal should not be embedded in XML attributes (quote-breaking risk).
		expect(text).not.toContain('goal="');
	});
});
