/**
 * Tests for plus/src/extensions/subagent/index.ts buildSubagentSection — the
 * <subagents> system-prompt section: nudges delegation and lists the
 * available agent types with source/tools/model details.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AgentConfig } from "../../src/extensions/subagent/agents.ts";
import { getBuiltinAgents } from "../../src/extensions/subagent/builtin.ts";
import { buildSubagentSection, SUBAGENT_SECTION_NAME } from "../../src/extensions/subagent/index.ts";

function agent(overrides: Partial<AgentConfig>): AgentConfig {
	return {
		name: "reviewer",
		description: "Reviews diffs",
		systemPrompt: "prompt",
		source: "project",
		filePath: "/repo/.pi/agents/reviewer.md",
		...overrides,
	};
}

describe("buildSubagentSection", () => {
	it("uses a valid system-prompt section name", () => {
		assert.match(SUBAGENT_SECTION_NAME, /^[a-z][a-z0-9_-]*$/);
	});

	it("nudges delegation of self-contained work", () => {
		const section = buildSubagentSection([]);
		assert.ok(section.includes("subagent tool"));
		assert.ok(section.includes("self-contained"));
		assert.ok(section.includes("concurrently"));
	});

	it("lists built-in agent types with their descriptions", () => {
		const section = buildSubagentSection(getBuiltinAgents());
		assert.ok(section.includes("- worker (builtin): General-purpose agent with the full toolset"));
		assert.ok(section.includes("explore"));
		assert.ok(section.includes("tools: read/grep/find/ls"));
	});

	it("includes source, tools, and model for custom agents", () => {
		const section = buildSubagentSection([
			agent({ name: "reviewer", model: "anthropic/claude-sonnet-4-6", tools: ["read", "bash"] }),
		]);
		assert.ok(
			section.includes("- reviewer (project, tools: read/bash, model: anthropic/claude-sonnet-4-6): Reviews diffs"),
		);
	});

	it("omits tools/model details when unset", () => {
		const section = buildSubagentSection([agent({})]);
		assert.ok(section.includes("- reviewer (project): Reviews diffs"));
	});
});
