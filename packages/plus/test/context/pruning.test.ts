/**
 * Tests for plus/src/context/pruning.ts — relevance-based pruning selection,
 * ported from openclaude/src/utils/relevancePruning.ts.
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, it } from "vitest";
import { estimateTokens } from "../../../coding-agent/src/core/compaction/compaction.ts";
import type { ProjectedSessionEntry, SessionEntry } from "../../../coding-agent/src/core/session-manager.ts";
import {
	DEFAULT_PRUNE_TAIL_TURNS,
	normalizePruneTailTurns,
	scoreEntryRelevance,
	selectPruneTargets,
} from "../../src/context/pruning.ts";

const NOW = 1_700_000_000_000;
const OLD = NOW - 3 * 60 * 60 * 1000; // 3h ago, outside the 1h recency window

function userMessage(text: string, timestamp = OLD): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistantMessage(text: string, timestamp = OLD): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "stop",
		timestamp,
	} as unknown as AssistantMessage;
}

function toolResultMessage(timestamp = OLD): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "output" }],
		isError: false,
		timestamp,
	} as AgentMessage;
}

function entry(id: string, messages: AgentMessage[], type = "message"): ProjectedSessionEntry {
	const sourceEntry = { type, id, parentId: null, timestamp: new Date(OLD).toISOString() } as SessionEntry;
	if (type === "message") {
		(sourceEntry as { message?: AgentMessage }).message = messages[0];
	}
	return { sourceEntry, messages };
}

function projectedTokens(entries: readonly ProjectedSessionEntry[]): number {
	let tokens = 0;
	for (const e of entries) for (const m of e.messages) tokens += estimateTokens(m);
	return tokens;
}

describe("normalizePruneTailTurns", () => {
	it("falls back to the default for unusable values", () => {
		assert.equal(normalizePruneTailTurns(undefined), DEFAULT_PRUNE_TAIL_TURNS);
		assert.equal(normalizePruneTailTurns("abc"), DEFAULT_PRUNE_TAIL_TURNS);
		assert.equal(normalizePruneTailTurns(0), DEFAULT_PRUNE_TAIL_TURNS);
		assert.equal(normalizePruneTailTurns(-2), DEFAULT_PRUNE_TAIL_TURNS);
		assert.equal(normalizePruneTailTurns({}), DEFAULT_PRUNE_TAIL_TURNS);
	});

	it("floors finite values >= 1 to an integer", () => {
		assert.equal(normalizePruneTailTurns(1), 1);
		assert.equal(normalizePruneTailTurns("5"), 5);
		assert.equal(normalizePruneTailTurns(2.7), 2);
	});
});

describe("scoreEntryRelevance", () => {
	it("scores a stale assistant text entry at the base 0.5", () => {
		assert.equal(scoreEntryRelevance(entry("e1", [assistantMessage("hello")]), NOW), 0.5);
	});

	it("adds recency and user-role boosts, capped at 1", () => {
		const recentUser = entry("e1", [userMessage("hello", NOW - 1000)]);
		assert.equal(scoreEntryRelevance(recentUser, NOW), 0.75); // 0.5 + 0.15 + 0.1
	});

	it("adds tool-interaction and error boosts", () => {
		const withTool = entry("e1", [toolResultMessage(NOW - 1000)]);
		assert.equal(scoreEntryRelevance(withTool, NOW), 0.9); // 0.5 + 0.25 + 0.15
	});
});

describe("selectPruneTargets", () => {
	it("returns no targets when the projection already fits the target", () => {
		const entries = [entry("e1", [userMessage("hello")])];
		assert.deepEqual(selectPruneTargets(entries, 100, 200, 3, NOW), []);
	});

	it("never omits entries in the protected recent tail", () => {
		const recentTurn = entry("recent", [userMessage("latest question", NOW), assistantMessage("latest answer", NOW)]);
		const oldTurn = entry("old", [userMessage("old question"), assistantMessage("old answer")]);
		const entries = [oldTurn, recentTurn];
		const tokens = projectedTokens(entries);
		// tailTurns=1 protects only the recent turn; the old turn is a candidate.
		const targets = selectPruneTargets(entries, tokens, 0, 1, NOW);
		assert.deepEqual(targets, ["old"]);
	});

	it("protects tool interactions, errors, and compaction entries even under pressure", () => {
		const toolTurn = entry("tool", [userMessage("run it"), assistantMessage("ok"), toolResultMessage()]);
		const errorTurn = entry("error", [
			userMessage("break it"),
			{ ...assistantMessage("boom"), stopReason: "error" } as AssistantMessage,
		]);
		const compactionEntry = entry("comp", [assistantMessage("previous summary")], "compaction");
		const textTurn = entry("text", [userMessage("plain chat"), assistantMessage("plain reply")]);
		const recentTurn = entry("recent", [userMessage("latest", NOW), assistantMessage("reply", NOW)]);
		const entries = [toolTurn, errorTurn, compactionEntry, textTurn, recentTurn];
		const tokens = projectedTokens(entries);
		const targets = selectPruneTargets(entries, tokens, 0, 1, NOW);
		assert.deepEqual(targets, ["text"]);
	});

	it("omits lowest-scoring candidates first and stops at the target", () => {
		// Big old user entry (score 0.6) and big recent-ish user entry (score 0.75):
		// the old one is omitted first; once under target, the newer one survives.
		const big = "x".repeat(4000);
		const oldBig = entry("old-big", [userMessage(big)]);
		const newBig = entry("new-big", [userMessage(big, NOW - 1000)]);
		const recentTurn = entry("recent", [userMessage("latest", NOW), assistantMessage("reply", NOW)]);
		const entries = [oldBig, newBig, recentTurn];
		const tokens = projectedTokens(entries);
		const oneEntry = projectedTokens([oldBig]);
		const target = tokens - oneEntry; // omitting old-big lands exactly at target
		const targets = selectPruneTargets(entries, tokens, target, 1, NOW);
		assert.deepEqual(targets, ["old-big"]);
	});

	it("drops the older entry first when scores tie", () => {
		const first = entry("first", [userMessage("same text")]);
		const second = entry("second", [userMessage("same text", OLD + 1000)]);
		const recentTurn = entry("recent", [userMessage("latest", NOW), assistantMessage("reply", NOW)]);
		const entries = [first, second, recentTurn];
		const tokens = projectedTokens(entries);
		const targets = selectPruneTargets(entries, tokens, 0, 1, NOW);
		assert.deepEqual(targets, ["first", "second"]);
	});

	it("protects everything when there are fewer turn starts than tailTurns", () => {
		const onlyTurn = entry("only", [userMessage("question"), assistantMessage("answer")]);
		const entries = [onlyTurn];
		const tokens = projectedTokens(entries);
		assert.deepEqual(selectPruneTargets(entries, tokens, 0, 3, NOW), []);
	});

	it("skips entries already omitted by context edits (empty projections)", () => {
		const omitted = entry("omitted", []);
		const textTurn = entry("text", [userMessage("plain chat"), assistantMessage("plain reply")]);
		const recentTurn = entry("recent", [userMessage("latest", NOW), assistantMessage("reply", NOW)]);
		const entries = [omitted, textTurn, recentTurn];
		const tokens = projectedTokens(entries);
		const targets = selectPruneTargets(entries, tokens, 0, 1, NOW);
		assert.deepEqual(targets, ["text"]);
	});
});
