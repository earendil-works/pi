/**
 * Tests for the subagent tool's TUI renderers: status is conveyed with words
 * ("running" / "done" / "failed") plus an animated spinner instead of the
 * default tool shell's blue/green background (renderShell "self" opts out of
 * that shell).
 */

import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { beforeAll, describe, it } from "vitest";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolRenderContext,
} from "../../../coding-agent/src/core/extensions/types.ts";
import { initTheme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { emptyUsage, type SubagentResult } from "../../src/extensions/subagent/format.ts";
import { registerSubagent } from "../../src/extensions/subagent/index.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function renderToText(component: { render(width: number): string[] }): string {
	return component.render(120).map(stripAnsi).join("\n").trim();
}

let toolDef!: ToolDefinition<any, any, any>;

beforeAll(() => {
	initTheme("dark");
	const api = {
		registerTool: (def: ToolDefinition<any, any, any>) => {
			toolDef = def;
		},
	} as unknown as ExtensionAPI;
	registerSubagent(api);
});

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as Message;
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		agent: "worker",
		agentSource: "builtin",
		task: "do things",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		...overrides,
	};
}

function renderContext(overrides: Partial<ToolRenderContext<any, any>> = {}): ToolRenderContext<any, any> {
	return {
		executionStarted: false,
		isPartial: true,
		state: {},
		invalidate: () => {},
		...overrides,
	} as ToolRenderContext<any, any>;
}

const callArgs = { description: "Fix the bug", prompt: "Investigate and fix the bug", agent: "worker" };

describe("subagent renderShell", () => {
	it('opts out of the colored default shell ("self")', () => {
		assert.equal(toolDef.renderShell, "self");
	});
});

describe("subagent renderCall", () => {
	it("shows the task without a status word before execution starts", () => {
		const text = renderToText(toolDef.renderCall!(callArgs, theme, renderContext({ isPartial: true })));
		assert.match(text, /subagent/);
		assert.match(text, /worker/);
		assert.match(text, /Fix the bug/);
		assert.doesNotMatch(text, /running/);
	});

	it('shows a spinner and the word "running" while executing', () => {
		const text = renderToText(
			toolDef.renderCall!(callArgs, theme, renderContext({ executionStarted: true, isPartial: true })),
		);
		assert.match(text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] running/);
	});

	it("spinner ticker lives in renderer state and drives invalidation", async () => {
		let invalidations = 0;
		const state: Record<string, unknown> = {};
		const ctx = renderContext({
			executionStarted: true,
			isPartial: true,
			state,
			invalidate: () => invalidations++,
		});
		const first = renderToText(toolDef.renderCall!(callArgs, theme, ctx));
		// A second render with the same state must reuse the ticker, not stack timers.
		renderToText(toolDef.renderCall!(callArgs, theme, ctx));
		assert.ok(state.runningSpinner, "ticker stored in renderer state");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const second = renderToText(toolDef.renderCall!(callArgs, theme, ctx));
		assert.notEqual(first, second, "frame advances over time");
		assert.ok(invalidations > 0, "ticker calls invalidate");
	});

	it('stops the ticker and drops the "running" word once the result is final', () => {
		const state: Record<string, unknown> = {};
		const running = renderContext({ executionStarted: true, isPartial: true, state });
		renderToText(toolDef.renderCall!(callArgs, theme, running));
		assert.ok(state.runningSpinner, "ticker started");
		const final = renderContext({ executionStarted: true, isPartial: false, state });
		const text = renderToText(toolDef.renderCall!(callArgs, theme, final));
		assert.doesNotMatch(text, /running/);
		assert.equal(state.runningSpinner, undefined, "ticker cleared");
	});
});

describe("subagent renderResult", () => {
	it("streams activity without a final-status word while partial", () => {
		const result = {
			content: [{ type: "text", text: "(running...)" }],
			details: makeResult({ messages: [assistantMessage("Investigating the code")] }),
		};
		const text = renderToText(
			toolDef.renderResult!(result as any, { expanded: false, isPartial: true }, theme, renderContext()),
		);
		assert.match(text, /Investigating the code/);
		assert.doesNotMatch(text, /\bdone\b/);
		assert.doesNotMatch(text, /failed/);
	});

	it("renders nothing while partial with no activity yet", () => {
		const result = {
			content: [{ type: "text", text: "(running...)" }],
			details: makeResult(),
		};
		const text = renderToText(
			toolDef.renderResult!(result as any, { expanded: false, isPartial: true }, theme, renderContext()),
		);
		assert.equal(text, "");
	});

	it('shows the word "done" for a successful final result', () => {
		const result = {
			content: [{ type: "text", text: "all fixed" }],
			details: makeResult({ messages: [assistantMessage("all fixed")] }),
		};
		const text = renderToText(
			toolDef.renderResult!(result as any, { expanded: false, isPartial: false }, theme, renderContext()),
		);
		assert.match(text, /✓ done/);
		assert.match(text, /worker/);
		assert.doesNotMatch(text, /failed/);
	});

	it('shows the word "failed" with the stop reason for a failed result', () => {
		const result = {
			content: [{ type: "text", text: "boom" }],
			details: makeResult({ exitCode: 1, stopReason: "error", errorMessage: "boom" }),
		};
		const text = renderToText(
			toolDef.renderResult!(result as any, { expanded: false, isPartial: false }, theme, renderContext()),
		);
		assert.match(text, /✗ failed/);
		assert.match(text, /\[error\]/);
		assert.match(text, /Error: boom/);
	});
});
