import { describe, expect, it } from "vitest";

import {
	buildHandoffDraftFromModelText,
	formatHandoffFileTrackingTags,
	HANDOFF_SUMMARY_SYSTEM_PROMPT,
} from "../src/handoff-summary.js";

const UPSTREAM_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const UPSTREAM_COMPACT_SUMMARY = [
	"## Goal",
	"Improve handoff quality by reusing compact summaries.",
	"",
	"## Constraints & Preferences",
	"- Reuse the upstream /compact approach.",
	"- Keep the parent thread reference and encourage read_thread.",
	"",
	"## Progress",
	"### Done",
	"- [x] Compared the current handoff stack with upstream compact helpers.",
	"",
	"### In Progress",
	"- [ ] Wire summary handoff to compact-style serialization and prompts.",
	"",
	"### Blocked",
	"- None.",
	"",
	"## Key Decisions",
	"- **Summary handoff should reuse compact**: The current bespoke handoff summary prompt is lower quality.",
	"",
	"## Next Steps",
	"1. Replace the bespoke handoff summary stack with the compact-style summary builder.",
	"2. Keep parent thread injection in the final handoff message.",
	"",
	"## Critical Context",
	"- Parent thread must be preserved and explicitly referenced.",
].join("\n");

describe("handoff summary compact parity", () => {
	it("reuses the upstream compact summarization system prompt", () => {
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toBe(UPSTREAM_SUMMARIZATION_SYSTEM_PROMPT);
	});

	it("preserves a valid upstream compact summary shape instead of replacing it with the bespoke handoff format", () => {
		const tags = formatHandoffFileTrackingTags({
			readFiles: ["packages/coding-agent/src/handoff-summary.ts"],
			modifiedFiles: ["packages/coding-agent/src/tui/tui-renderer.ts"],
		});

		const draft = buildHandoffDraftFromModelText({
			goal: "Improve handoff quality",
			modelText: UPSTREAM_COMPACT_SUMMARY,
			readFiles: ["packages/coding-agent/src/handoff-summary.ts"],
			modifiedFiles: ["packages/coding-agent/src/tui/tui-renderer.ts"],
		});

		expect(draft).toBe(`${UPSTREAM_COMPACT_SUMMARY}\n\n${tags}`);
		expect(draft).not.toContain("## Guide Questions");
		expect(draft).not.toContain("## What's Done");
		expect(draft).not.toContain("## What's Not Yet Done");
		expect(draft).not.toContain("## Learnings / Insights so Far");
	});

	it("falls back to the upstream compact section layout when the model output is malformed", () => {
		const draft = buildHandoffDraftFromModelText({
			goal: "Improve handoff quality",
			modelText: "Unstructured text without any required headings.",
			readFiles: [],
			modifiedFiles: [],
		});

		expect(draft).toContain("## Goal");
		expect(draft).toContain("## Constraints & Preferences");
		expect(draft).toContain("## Progress");
		expect(draft).toContain("### Done");
		expect(draft).toContain("### In Progress");
		expect(draft).toContain("### Blocked");
		expect(draft).toContain("## Key Decisions");
		expect(draft).toContain("## Next Steps");
		expect(draft).toContain("## Critical Context");
		expect(draft).not.toContain("## What's Done");
		expect(draft).not.toContain("## What's Not Yet Done");
		expect(draft).not.toContain("## Learnings / Insights so Far");
		expect(draft).not.toContain("## Guide Questions");
	});
});
