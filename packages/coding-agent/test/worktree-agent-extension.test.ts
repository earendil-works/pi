import { describe, expect, it } from "vitest";
import {
	createWorktreeBranchName,
	createWorktreePath,
	parseJsonModeEvent,
	sanitizePathSegment,
} from "../examples/extensions/worktree-agent/index.ts";

describe("worktree-agent extension helpers", () => {
	it("creates safe branch names from tasks", () => {
		expect(
			createWorktreeBranchName("Fix HTTP API!", {
				now: new Date("2026-05-31T01:02:03.000Z"),
				suffix: "abc123",
			}),
		).toBe("pi/agent/fix-http-api-20260531010203-abc123");
	});

	it("creates deterministic worktree paths with repo disambiguation", () => {
		const path = createWorktreePath("/tmp/pi-worktrees", "/Users/alice/project", "pi/agent/fix-api");

		expect(path).toContain("/tmp/pi-worktrees/project-");
		expect(path.endsWith("/pi-agent-fix-api")).toBe(true);
	});

	it("sanitizes path segments", () => {
		expect(sanitizePathSegment(" ../Feature: One ")).toBe("feature-one");
		expect(sanitizePathSegment("!!!", "fallback")).toBe("fallback");
	});

	it("parses json mode events with messages", () => {
		const event = parseJsonModeEvent(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				},
			}),
		);

		expect(event?.type).toBe("message_end");
		expect(event?.message?.role).toBe("assistant");
		expect(parseJsonModeEvent("not json")).toBeUndefined();
	});
});
