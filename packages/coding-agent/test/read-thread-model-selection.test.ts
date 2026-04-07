import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Context, Message, Model, TextContent } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function isTextContent(value: unknown): value is TextContent {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || !("text" in value)) return false;
	const v = value as { type: unknown; text: unknown };
	return v.type === "text" && typeof v.text === "string";
}

const { completeSimpleMock, findModelMock, getApiKeyForModelMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
	findModelMock: vi.fn(),
	getApiKeyForModelMock: vi.fn(),
}));

vi.mock("@kennyfrc/mu-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@kennyfrc/mu-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

vi.mock("../src/model-config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/model-config.js")>();
	return {
		...actual,
		findModel: findModelMock,
		getApiKeyForModel: getApiKeyForModelMock,
	};
});

import { getCurrentModel, setCurrentModel } from "../src/runtime-state.js";
import { readThreadTool } from "../src/tools/read-thread.js";

function toWorkspaceDirName(cwd: string): string {
	return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

const currentModel: Model<Api> = {
	id: "current-model",
	name: "Current Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const fireworksModel: Model<Api> = {
	id: "accounts/fireworks/routers/kimi-k2p5-turbo",
	name: "Fireworks Kimi",
	api: "openai-completions",
	provider: "fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 32768,
};

describe("readThreadTool model selection", () => {
	const origCwd = process.cwd();
	const origMuDir = process.env.MU_CODING_AGENT_DIR;
	const previousModel = getCurrentModel();

	let testRoot: string;
	let testProject: string;

	beforeEach(() => {
		testRoot = mkdtempSync(join(tmpdir(), "read-thread-model-selection-"));
		testProject = join(testRoot, "project");
		mkdirSync(testProject, { recursive: true });
		process.chdir(testProject);

		process.env.MU_CODING_AGENT_DIR = testRoot;

		const sessionsRoot = join(resolve(testRoot), "sessions");
		const wsDir = join(sessionsRoot, toWorkspaceDirName(testProject));
		mkdirSync(wsDir, { recursive: true });

		const threadId = "thread-kimi-123";
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

		setCurrentModel(currentModel);
		findModelMock.mockImplementation((provider: string, modelId: string) => {
			if (provider === "fireworks" && modelId === "accounts/fireworks/routers/kimi-k2p5-turbo") {
				return { model: fireworksModel, error: null };
			}
			return { model: null, error: null };
		});
		getApiKeyForModelMock.mockResolvedValue("fireworks-key");
		completeSimpleMock.mockImplementation(async (_model: unknown, context: Context) => {
			const text = context.messages
				.flatMap((m: Message): unknown[] => {
					if (m.role === "assistant") return m.content;
					if (m.role === "user") return typeof m.content === "string" ? [] : m.content;
					return m.content;
				})
				.filter(isTextContent)
				.map((c) => c.text)
				.join("\n");

			expect(text).toContain("m5");
			expect(text).toContain("m9");
			expect(text).not.toContain("m0");

			return {
				role: "assistant",
				content: [{ type: "text", text: "<analysis>OK</analysis>" }],
				api: "openai-completions",
				provider: "fireworks",
				model: fireworksModel.id,
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
		});
	});

	afterEach(() => {
		process.chdir(origCwd);
		if (origMuDir === undefined) delete process.env.MU_CODING_AGENT_DIR;
		else process.env.MU_CODING_AGENT_DIR = origMuDir;
		if (previousModel) setCurrentModel(previousModel);
		completeSimpleMock.mockReset();
		findModelMock.mockReset();
		getApiKeyForModelMock.mockReset();
	});

	it("prefers fireworks kimi turbo with maxTokens 32768 and medium reasoning", async () => {
		const result = await readThreadTool.execute("call-1", {
			id: "thread-kimi-123",
			goal: "What are the last messages?",
			max_messages: 5,
		});

		const text = result.content
			.filter(isTextContent)
			.map((c) => c.text)
			.join("");

		expect(text).toContain("<thread_extract>");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock).toHaveBeenCalledWith(
			fireworksModel,
			expect.anything(),
			expect.objectContaining({ apiKey: "fireworks-key", maxTokens: 32768, reasoning: "medium" }),
		);
	});
});
