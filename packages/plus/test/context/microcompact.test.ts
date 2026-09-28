/**
 * Tests for plus/src/context/microcompact.ts — time-based micro-compact,
 * ported from openclaude/src/services/compact/microCompact.ts.
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, it } from "vitest";
import type { SessionEntry } from "../../../coding-agent/src/core/session-manager.ts";
import {
	applyIdleMicroCompact,
	getMicroCompactIdleMs,
	getMicroCompactKeepRecent,
	isMicroCompactableTool,
	selectToolResultsToClear,
	TIME_BASED_MC_CLEARED_MESSAGE,
} from "../../src/context/microcompact.ts";

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

function assistantEntry(id: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			stopReason: "stop",
			timestamp,
		} as unknown as AgentMessage,
	} as SessionEntry;
}

function toolResultEntry(
	id: string,
	timestamp: number,
	toolName = "bash",
	overrides: Record<string, unknown> = {},
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName,
			content: [{ type: "text", text: `output of ${id}` }],
			isError: false,
			timestamp,
			...overrides,
		} as unknown as AgentMessage,
	} as SessionEntry;
}

function userEntry(id: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: [{ type: "text", text: "do it" }], timestamp } as unknown as AgentMessage,
	} as SessionEntry;
}

describe("isMicroCompactableTool", () => {
	it("accepts pi's read-only/output tools and mcp__ tools", () => {
		for (const name of ["bash", "edit", "write", "read", "grep", "find", "ls", "powershell", "mcp__docs__search"]) {
			assert.equal(isMicroCompactableTool(name), true, name);
		}
		assert.equal(isMicroCompactableTool("ask_user"), false);
		assert.equal(isMicroCompactableTool("EnterPlanMode"), false);
	});
});

describe("env knobs", () => {
	afterEach(() => {
		delete process.env.PI_MICROCOMPACT_IDLE_MINUTES;
		delete process.env.PI_MICROCOMPACT_KEEP_RECENT;
	});

	it("defaults to 60 minutes and 5 kept results", () => {
		assert.equal(getMicroCompactIdleMs(), 60 * 60 * 1000);
		assert.equal(getMicroCompactKeepRecent(), 5);
	});

	it("parses overrides; non-positive or invalid values fall back", () => {
		process.env.PI_MICROCOMPACT_IDLE_MINUTES = "30";
		assert.equal(getMicroCompactIdleMs(), 30 * 60 * 1000);
		process.env.PI_MICROCOMPACT_IDLE_MINUTES = "0";
		assert.equal(getMicroCompactIdleMs(), 60 * 60 * 1000);
		process.env.PI_MICROCOMPACT_IDLE_MINUTES = "soon";
		assert.equal(getMicroCompactIdleMs(), 60 * 60 * 1000);

		process.env.PI_MICROCOMPACT_KEEP_RECENT = "2";
		assert.equal(getMicroCompactKeepRecent(), 2);
		process.env.PI_MICROCOMPACT_KEEP_RECENT = "0";
		assert.equal(getMicroCompactKeepRecent(), 5);
	});
});

describe("selectToolResultsToClear", () => {
	it("does not fire when the idle gap is under the threshold", () => {
		const entries = [assistantEntry("a1", NOW - 30 * 60 * 1000), toolResultEntry("t1", NOW - 30 * 60 * 1000)];
		assert.equal(selectToolResultsToClear(entries, NOW, HOUR_MS, 5), undefined);
	});

	it("clears old compactable tool results, keeping the newest keepRecent", () => {
		const entries = [
			assistantEntry("a1", NOW - 3 * HOUR_MS),
			toolResultEntry("t1", NOW - 3 * HOUR_MS),
			toolResultEntry("t2", NOW - 2 * HOUR_MS),
			toolResultEntry("t3", NOW - HOUR_MS),
			toolResultEntry("t4", NOW - 30 * 60 * 1000),
		];
		const selection = selectToolResultsToClear(entries, NOW, HOUR_MS, 2);
		assert.deepEqual(selection?.clearEntryIds, ["t1", "t2"]);
		assert.equal(selection?.keptRecent, 2);
		assert.equal(selection?.gapMinutes, 180);
	});

	it("returns undefined when idleMs is non-positive (feature disabled)", () => {
		const entries = [assistantEntry("a1", NOW - 3 * HOUR_MS), toolResultEntry("t1", NOW - 3 * HOUR_MS)];
		assert.equal(selectToolResultsToClear(entries, NOW, 0, 5), undefined);
	});

	it("returns undefined when there is no assistant message", () => {
		const entries = [userEntry("u1", NOW - 3 * HOUR_MS), toolResultEntry("t1", NOW - 3 * HOUR_MS)];
		assert.equal(selectToolResultsToClear(entries, NOW, HOUR_MS, 5), undefined);
	});

	it("skips non-compactable tools, error results, and image content", () => {
		const entries = [
			assistantEntry("a1", NOW - 3 * HOUR_MS),
			toolResultEntry("t1", NOW - 3 * HOUR_MS),
			toolResultEntry("t2", NOW - 3 * HOUR_MS, "ask_user"),
			toolResultEntry("t3", NOW - 3 * HOUR_MS, "bash", { isError: true }),
			toolResultEntry("t4", NOW - 3 * HOUR_MS, "bash", {
				content: [
					{ type: "text", text: "img" },
					{ type: "image", data: "...", mimeType: "image/png" },
				],
			}),
			toolResultEntry("t5", NOW - 2 * HOUR_MS, "mcp__docs__search"),
		];
		// keepRecent=1 keeps only the newest compactable result (t5).
		const selection = selectToolResultsToClear(entries, NOW, HOUR_MS, 1);
		assert.deepEqual(selection?.clearEntryIds, ["t1"]);
	});
});

describe("applyIdleMicroCompact", () => {
	afterEach(() => {
		delete process.env.PI_MICROCOMPACT_KEEP_RECENT;
	});

	it("appends context_edit overlays with the CC marker for each cleared result", () => {
		process.env.PI_MICROCOMPACT_KEEP_RECENT = "1";
		const entries = [
			assistantEntry("a1", NOW - 3 * HOUR_MS),
			toolResultEntry("t1", NOW - 3 * HOUR_MS),
			toolResultEntry("t2", NOW - 2 * HOUR_MS),
		];
		const edits: { targetId: string; replacement: unknown }[] = [];
		const sessionManager = {
			getBranch: () => entries,
			appendContextEdit: (targetId: string, replacement: unknown) => {
				edits.push({ targetId, replacement });
			},
		};
		const cleared = applyIdleMicroCompact(sessionManager as never, NOW);
		assert.equal(cleared, 1); // keepRecent=1 keeps t2, clears t1
		assert.deepEqual(edits, [
			{ targetId: "t1", replacement: { content: [{ type: "text", text: TIME_BASED_MC_CLEARED_MESSAGE }] } },
		]);
	});

	it("is a no-op when the trigger does not fire", () => {
		const entries = [assistantEntry("a1", NOW - 10 * 60 * 1000), toolResultEntry("t1", NOW - 10 * 60 * 1000)];
		let calls = 0;
		const sessionManager = {
			getBranch: () => entries,
			appendContextEdit: () => {
				calls++;
			},
		};
		assert.equal(applyIdleMicroCompact(sessionManager as never, NOW), 0);
		assert.equal(calls, 0);
	});
});
