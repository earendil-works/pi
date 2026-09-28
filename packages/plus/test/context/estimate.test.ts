/**
 * Tests for plus/src/context/estimate.ts — whole-request context estimation.
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, SystemMessage, Usage } from "@earendil-works/pi-ai/compat";
import { describe, it } from "vitest";
import {
	calculateContextTokensPlus,
	estimateContextTokensPlus,
	estimateEffectiveSystemTokens,
	estimateSystemMessageTokens,
} from "../../src/context/estimate.ts";

function makeUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function makeAssistant(timestamp: number, usage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function makeSystem(timestamp: number, content: string, extra: Partial<SystemMessage> = {}): SystemMessage {
	return { role: "system", content, timestamp, ...extra };
}

function makeUser(timestamp: number, text: string): AgentMessage {
	return { role: "user", content: text, timestamp };
}

describe("calculateContextTokensPlus", () => {
	it("prefers the provider-reported totalTokens", () => {
		const usage = makeUsage({ totalTokens: 1234, input: 100, output: 50 });
		assert.equal(calculateContextTokensPlus(usage), 1234);
	});

	it("adds 1h cache writes when reported outside the 5m bucket (Anthropic)", () => {
		const usage = makeUsage({ totalTokens: 1000, cacheWrite: 0, cacheWrite1h: 500 });
		assert.equal(calculateContextTokensPlus(usage), 1500);
	});

	it("does not double-count 1h cache writes reported as a subset (Bedrock)", () => {
		const usage = makeUsage({ totalTokens: 1000, cacheWrite: 800, cacheWrite1h: 300 });
		assert.equal(calculateContextTokensPlus(usage), 1000);
	});

	it("falls back to component sums when totalTokens is missing", () => {
		const usage = makeUsage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 0 });
		assert.equal(calculateContextTokensPlus(usage), 160);
	});
});

describe("estimateSystemMessageTokens", () => {
	it("counts rendered prompt text (content + sections) plus tool declarations", () => {
		const system = makeSystem(1, "x".repeat(400), {
			sections: { rules: "y".repeat(400) },
			toolsAdded: [{ name: "bash_tool", description: "run".repeat(100), parameters: { type: "object" } }],
		});
		const tokens = estimateSystemMessageTokens(system);
		// 400 (content) + 400 (rules) + "\n\n" joiner + tool JSON, all /4
		assert.ok(tokens > 200, `expected tools to contribute, got ${tokens}`);
		assert.equal(tokens, Math.ceil((800 + 2 + JSON.stringify(system.toolsAdded).length) / 4));
	});
});

describe("estimateEffectiveSystemTokens", () => {
	it("folds section patches instead of counting them per message", () => {
		const base = makeSystem(1, "base".repeat(100), { sections: { rules: "a".repeat(400) } });
		const patch = makeSystem(2, "", { sections: { rules: "b".repeat(400), docs: "c".repeat(400) } });
		const messages = [base, patch] as AgentMessage[];
		const tokens = estimateEffectiveSystemTokens(messages);
		// Folded: base content + rules("b"×400, replaced) + docs("c"×400) joined with
		// "\n\n" — the replaced "a"×400 section must not appear.
		const expected = Math.ceil((400 * 3 + 2) / 4);
		assert.equal(tokens, expected);
	});

	it("accumulates content from later system messages (no reset semantics)", () => {
		// Upstream removed `SystemMessage.replace`: later content is appended to the
		// base prompt, so both texts count. Folded content is "a"×4000 + "\n\n" + "b"×400.
		const first = makeSystem(1, "a".repeat(4000));
		const second = makeSystem(2, "b".repeat(400));
		const tokens = estimateEffectiveSystemTokens([first, second] as AgentMessage[]);
		assert.equal(tokens, Math.ceil((4000 + 2 + 400) / 4));
	});

	it("accumulates toolsAdded across messages", () => {
		const base = makeSystem(1, "", {
			toolsAdded: [{ name: "t1", description: "d".repeat(100), parameters: { type: "object" } }],
		});
		const more = makeSystem(2, "", {
			toolsAdded: [{ name: "t2", description: "d".repeat(100), parameters: { type: "object" } }],
		});
		const tokens = estimateEffectiveSystemTokens([base, more] as AgentMessage[]);
		const single = estimateEffectiveSystemTokens([base] as AgentMessage[]);
		assert.ok(tokens > single, "second tool should add tokens");
	});
});

describe("estimateContextTokensPlus", () => {
	it("fallback path (no usage) includes the folded system prompt", () => {
		const system = makeSystem(1, "s".repeat(4000));
		const user = makeUser(2, "hello world");
		const result = estimateContextTokensPlus([system, user] as AgentMessage[]);
		assert.equal(result.lastUsageIndex, null);
		assert.equal(result.usageTokens, 0);
		// system 4000/4 + user 11/4
		assert.equal(result.tokens, 1000 + Math.ceil(11 / 4));
	});

	it("anchor path: usage total plus trailing message estimate", () => {
		const system = makeSystem(1, "s".repeat(400));
		const user = makeUser(2, "hi");
		const assistant = makeAssistant(3, makeUsage({ totalTokens: 1000 }));
		const trailing = makeUser(4, "a".repeat(40));
		const result = estimateContextTokensPlus([system, user, assistant, trailing] as AgentMessage[]);
		assert.equal(result.lastUsageIndex, 2);
		assert.equal(result.usageTokens, 1000);
		assert.equal(result.trailingTokens, 10);
		assert.equal(result.tokens, 1010);
	});

	it("anchor path: skips zero-usage, aborted, and error assistant messages", () => {
		const assistantZero = makeAssistant(1, makeUsage({ totalTokens: 0 }));
		const assistantAborted = { ...makeAssistant(2, makeUsage({ totalTokens: 500 })), stopReason: "aborted" };
		const user = makeUser(3, "hello world");
		const result = estimateContextTokensPlus([assistantZero, assistantAborted, user] as AgentMessage[]);
		assert.equal(result.lastUsageIndex, null);
	});

	it("prefix guard: a newer-timestamp message before the anchor invalidates its usage", () => {
		const user = makeUser(1, "hi");
		const assistant = makeAssistant(2, makeUsage({ totalTokens: 1000 }));
		// Simulates a compaction summary inserted into the middle of the transcript
		// after the assistant responded (timestamp newer than the anchor's prefix).
		const inserted = makeUser(1, "compaction summary text");
		inserted.timestamp = 5;
		const messages = [user, inserted, assistant] as AgentMessage[];
		const result = estimateContextTokensPlus(messages);
		assert.equal(result.lastUsageIndex, null);
		assert.equal(result.usageTokens, 0);
	});

	it("adds folded system tokens when the system state changes after the anchor", () => {
		const system = makeSystem(1, "s".repeat(400));
		const user = makeUser(2, "hi");
		const assistant = makeAssistant(3, makeUsage({ totalTokens: 1000 }));
		const systemPatch = makeSystem(4, "", {
			toolsAdded: [{ name: "t1", description: "d".repeat(400), parameters: { type: "object" } }],
		});
		const result = estimateContextTokensPlus([system, user, assistant, systemPatch] as AgentMessage[]);
		const systemTokens = estimateEffectiveSystemTokens([system, systemPatch] as AgentMessage[]);
		assert.ok(systemTokens > 0);
		assert.equal(result.tokens, 1000 + systemTokens);
	});

	it("does not add system tokens twice when nothing changed after the anchor", () => {
		const system = makeSystem(1, "s".repeat(4000));
		const user = makeUser(2, "hi");
		const assistant = makeAssistant(3, makeUsage({ totalTokens: 1000 }));
		const result = estimateContextTokensPlus([system, user, assistant] as AgentMessage[]);
		assert.equal(result.tokens, 1000);
	});
});
