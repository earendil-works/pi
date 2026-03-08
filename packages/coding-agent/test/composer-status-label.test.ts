import type { AgentState } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { formatComposerStatusLabel } from "../src/tui/composer-status-label.js";

describe("formatComposerStatusLabel", () => {
	initTheme("dark");

	const state: AgentState = {
		systemPrompt: "",
		messages: [],
		model: getModel("openai-codex", "gpt-5.1"),
		thinkingLevel: "medium",
		fastMode: false,
		tools: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
	};

	it("shows an explicit bash marker when bash mode is active", () => {
		const label = formatComposerStatusLabel(state, true);

		expect(stripAnsi(label)).toBe("gpt-5.1 • medium [openai-codex] • BASH");
		expect(label).toContain("BASH");
	});

	it("leaves the normal model label unchanged when bash mode is inactive", () => {
		const label = formatComposerStatusLabel(state, false);

		expect(stripAnsi(label)).toBe("gpt-5.1 • medium [openai-codex]");
	});
});
