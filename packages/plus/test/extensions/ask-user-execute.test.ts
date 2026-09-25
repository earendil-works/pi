/**
 * Tests for the ask_user tool's execute path (plus/src/extensions/ask-user/index.ts):
 * non-interactive rejection, TUI custom-dialog path, decline, RPC fallback
 * dialogs, and validation failures. Uses a captured registerTool definition
 * with a mocked ExtensionContext — no provider or TUI involved.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../../../coding-agent/src/core/extensions/types.ts";
import { registerAskUser } from "../../src/extensions/ask-user/index.ts";
import type { AskUserAnswers, AskUserQuestion } from "../../src/extensions/ask-user/schema.ts";

function makeQuestions(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion[] {
	return [
		{
			question: "Which library?",
			header: "Library",
			options: [
				{ label: "date-fns", description: "Lightweight" },
				{ label: "dayjs", description: "Small" },
			],
			...overrides,
		},
	];
}

type Params = { questions: AskUserQuestion[] };

function capturedTool(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	registerAskUser({
		registerTool: (definition: unknown) => {
			tool = definition as ToolDefinition;
		},
	} as never);
	assert.ok(tool, "registerAskUser must register exactly one tool");
	return tool;
}

function mockCtx(ui: Record<string, unknown>, mode: string, hasUI: boolean): ExtensionContext {
	return { mode, hasUI, ui } as unknown as ExtensionContext;
}

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

async function run(tool: ToolDefinition, params: Params, ctx: ExtensionContext): Promise<ToolResult> {
	return tool.execute("call-1", params, undefined, undefined, ctx) as Promise<ToolResult>;
}

function firstText(result: ToolResult): string {
	const block = result.content[0];
	return block?.type === "text" ? block.text : "";
}

function answersOf(result: ToolResult): AskUserAnswers {
	return (result.details as { answers: AskUserAnswers }).answers;
}

describe("ask_user execute", () => {
	it("registers as a sequential tool named ask_user", () => {
		const tool = capturedTool();
		assert.equal(tool.name, "ask_user");
		assert.equal(tool.executionMode, "sequential");
		assert.ok(tool.description.includes("multiple choice"));
		assert.ok(tool.promptSnippet?.includes("ask_user"));
	});

	it("throws a validation error for guardrail violations", async () => {
		const tool = capturedTool();
		const tooMany = Array.from({ length: 5 }, (_, i) => ({
			question: `Q${i}?`,
			header: `H${i}`,
			options: [
				{ label: "a", description: "a" },
				{ label: "b", description: "b" },
			],
		}));
		await assert.rejects(run(tool, { questions: tooMany }, mockCtx({}, "tui", true)), /between 1 and 4/);
	});

	it("throws in non-interactive (print/json) mode", async () => {
		const tool = capturedTool();
		await assert.rejects(
			run(tool, { questions: makeQuestions() }, mockCtx({}, "print", false)),
			/not available in non-interactive mode/,
		);
		await assert.rejects(
			run(tool, { questions: makeQuestions() }, mockCtx({}, "json", false)),
			/not available in non-interactive mode/,
		);
	});

	it("uses the custom TUI dialog in tui mode and formats the answers", async () => {
		const tool = capturedTool();
		let seenOptions: unknown;
		const answers: AskUserAnswers = { "Which library?": "date-fns" };
		const ui = {
			custom: async (_factory: unknown, options?: unknown) => {
				seenOptions = options;
				return answers;
			},
		};
		const result = await run(tool, { questions: makeQuestions() }, mockCtx(ui, "tui", true));
		assert.deepEqual(seenOptions, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } });
		assert.ok(firstText(result).includes('"Which library?"="date-fns"'));
		assert.deepEqual(answersOf(result), answers);
	});

	it("throws a decline error when the TUI dialog resolves undefined", async () => {
		const tool = capturedTool();
		const ui = { custom: async () => undefined };
		await assert.rejects(run(tool, { questions: makeQuestions() }, mockCtx(ui, "tui", true)), /declined/);
	});

	it("drives the RPC fallback with select plus Other input", async () => {
		const tool = capturedTool();
		const calls: { method: string; args: unknown[] }[] = [];
		const ui = {
			select: async (...args: unknown[]) => {
				calls.push({ method: "select", args });
				return "Other";
			},
			input: async (...args: unknown[]) => {
				calls.push({ method: "input", args });
				return "  moment  ";
			},
		};
		const result = await run(tool, { questions: makeQuestions() }, mockCtx(ui, "rpc", true));
		assert.equal(calls.length, 2);
		assert.equal(calls[0].method, "select");
		assert.deepEqual(calls[0].args[1], ["date-fns", "dayjs", "Other"]);
		assert.equal(calls[1].method, "input");
		assert.equal(answersOf(result)["Which library?"], "moment");
	});

	it("uses the plain select choice in RPC mode without an input follow-up", async () => {
		const tool = capturedTool();
		const calls: string[] = [];
		const ui = {
			select: async () => {
				calls.push("select");
				return "dayjs";
			},
			input: async () => {
				calls.push("input");
				return "unused";
			},
		};
		const result = await run(tool, { questions: makeQuestions() }, mockCtx(ui, "rpc", true));
		assert.deepEqual(calls, ["select"]);
		assert.equal(answersOf(result)["Which library?"], "dayjs");
	});

	it("declines in RPC mode when the host cancels a dialog", async () => {
		const tool = capturedTool();
		const ui = { select: async () => undefined };
		await assert.rejects(run(tool, { questions: makeQuestions() }, mockCtx(ui, "rpc", true)), /declined/);
	});

	it("joins multiSelect confirmations in RPC mode", async () => {
		const tool = capturedTool();
		const questions = makeQuestions({ multiSelect: true });
		const ui = {
			confirm: async (_title: string, message: string) => message.includes("date-fns"),
			input: async () => "",
		};
		const result = await run(tool, { questions }, mockCtx(ui, "rpc", true));
		assert.equal(answersOf(result)["Which library?"], "date-fns");
	});
});
