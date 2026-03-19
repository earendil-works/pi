import { readFileSync } from "node:fs";
import type { Message } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

type MorphProjectedMessage = {
	role: "user" | "assistant";
	content: string;
};

type MorphCompactionProjectorModule = {
	projectMessagesToMorphMessages(messages: Message[]): MorphProjectedMessage[];
	projectMessagesToMorphTranscript(messages: Message[]): string;
	normalizeMorphCompactionQuery(args: { messages: Message[]; explicitGoal?: string | null }): string;
	containsNativeCompactReplay(messages: Message[]): boolean;
};

type FixtureFile = {
	id: string;
	messages: Message[];
	goal?: string;
	query?: string;
	expectedVerbatimLine?: string;
};

async function loadMorphCompactionProjectorModule(): Promise<MorphCompactionProjectorModule> {
	return (await import("../src/morph-compaction-projector.js")) as MorphCompactionProjectorModule;
}

function loadFixture(path: string): FixtureFile {
	return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as FixtureFile;
}

describe("normalizeMorphCompactionQuery", () => {
	it("strips the user_message_time wrapper and keeps the first actionable line", async () => {
		const mod = await loadMorphCompactionProjectorModule();
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: [
							"<user_message_time>Thursday, March 19, 2026 at 9:21 PM GMT+8</user_message_time>",
							"",
							"Fix the login page tests",
							"",
							"## Pasted notes",
							"A giant pasted blob should not become the Morph query.",
						].join("\n"),
					},
				],
				timestamp: 1,
			},
		];

		expect(mod.normalizeMorphCompactionQuery({ messages })).toBe("Fix the login page tests");
	});
});

describe("projectMessagesToMorphMessages", () => {
	it("projects user, assistant, tool call, thinking, and tool result content into Morph-safe text messages", async () => {
		const mod = await loadMorphCompactionProjectorModule();
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Fix the parser failure" }],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Need to inspect the parser failure before editing." },
					{ type: "text", text: "I'll inspect the parser." },
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "rg -n 'parse' src" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4o-mini",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "src/parser.ts:12: export function parseInput()" }],
				isError: false,
				timestamp: 3,
			},
		];

		expect(mod.projectMessagesToMorphMessages(messages)).toEqual([
			{ role: "user", content: "Fix the parser failure" },
			{
				role: "assistant",
				content: [
					"Thinking:",
					"Need to inspect the parser failure before editing.",
					"",
					"Assistant:",
					"I'll inspect the parser.",
					"",
					'ToolCall(bash): {"command":"rg -n \'parse\' src"}',
				].join("\n"),
			},
			{
				role: "assistant",
				content: ["ToolResult(bash):", "src/parser.ts:12: export function parseInput()"].join("\n"),
			},
		]);
	});
});

describe("projectMessagesToMorphTranscript", () => {
	it("builds a plain-text transcript from the visible-history fixture without leaking timestamp wrappers", async () => {
		const mod = await loadMorphCompactionProjectorModule();
		const fixture = loadFixture(
			"../../../devdocs/missions/morph-compaction-control/fixtures/visible-history-compaction.json",
		);

		const transcript = mod.projectMessagesToMorphTranscript(fixture.messages);
		expect(transcript).toContain("User: There is a bug in resume semantics of the missions");
		expect(transcript).toContain("AssistantThinking: **Reading specifications and documentation**");
		expect(transcript).toContain("ToolCall(bash):");
		expect(transcript).toContain("ToolResult(bash): ?? devdocs/missions/demo/");
		expect(transcript).toContain(fixture.expectedVerbatimLine ?? "");
		expect(transcript).not.toContain("<user_message_time>");
	});
});

describe("containsNativeCompactReplay", () => {
	it("detects opaque native replay carriers and leaves visible-history fixtures clear", async () => {
		const mod = await loadMorphCompactionProjectorModule();
		const nativeReplayFixture = loadFixture(
			"../../../devdocs/missions/morph-compaction-control/fixtures/native-replay-required.json",
		);
		const visibleHistoryFixture = loadFixture(
			"../../../devdocs/missions/morph-compaction-control/fixtures/visible-history-compaction.json",
		);

		expect(mod.containsNativeCompactReplay(nativeReplayFixture.messages)).toBe(true);
		expect(mod.containsNativeCompactReplay(visibleHistoryFixture.messages)).toBe(false);
	});
});
