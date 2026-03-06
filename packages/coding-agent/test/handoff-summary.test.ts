import { describe, expect, it } from "vitest";

import {
	buildHandoffDraftFromModelText,
	buildHandoffSummaryUserText,
	formatHandoffFileTrackingTags,
	HANDOFF_SUMMARY_SYSTEM_PROMPT,
} from "../src/handoff-summary.js";

describe("handoff summary", () => {
	it("builds a summarization user payload with <conversation> wrapper and deterministic file tags", () => {
		const userText = buildHandoffSummaryUserText({
			goal: "Fix failing tests",
			conversation: "User: hi\n\nAssistant: ok",
			readFiles: ["a.ts"],
			modifiedFiles: ["b.ts"],
		});

		expect(userText).toContain("<conversation>");
		expect(userText).toContain("User: hi");
		expect(userText).toContain("</conversation>");
		expect(userText).toContain("<read-files>");
		expect(userText).toContain("a.ts");
		expect(userText).toContain("<modified-files>");
		expect(userText).toContain("b.ts");
	});

	it("appends deterministic file tags + guide questions to a well-formed model summary", () => {
		const modelText = [
			"## Goal",
			"Fix failing tests.",
			"",
			"## Constraints & Preferences",
			"- Preserve exact file paths and error messages.",
			"",
			"## Progress",
			"### Done",
			"- [x] Investigated failures.",
			"",
			"### In Progress",
			"- [ ] Apply fix.",
			"",
			"### Blocked",
			"- None.",
			"",
			"## Key Decisions",
			"- **Root cause**: X.",
			"",
			"## Next Steps",
			"1. Implement Y.",
			"",
			"## Critical Context",
			"- stack trace Z.",
		].join("\n");

		const draft = buildHandoffDraftFromModelText({
			goal: "Fix failing tests",
			modelText,
			readFiles: ["a.ts"],
			modifiedFiles: ["b.ts"],
		});

		expect(draft).toContain("## Constraints & Preferences");
		expect(draft).toContain("## Progress");
		expect(draft).toContain("## Key Decisions");
		expect(draft).not.toContain("## Guide Questions");
		expect(draft).toContain("<read-files>");
		expect(draft).toContain("a.ts");
		expect(draft).toContain("<modified-files>");
		expect(draft).toContain("b.ts");
	});

	it("falls back to a stub template when the model output is not in the required format", () => {
		const draft = buildHandoffDraftFromModelText({
			goal: "Do the thing",
			modelText: "Just a paragraph, no headings.",
			readFiles: [],
			modifiedFiles: [],
		});

		expect(draft).toContain("## Goal");
		expect(draft).toContain("Do the thing");
		expect(draft).toContain("## Constraints & Preferences");
		expect(draft).toContain("## Progress");
		expect(draft).toContain("## Key Decisions");
		expect(draft).toContain("Just a paragraph, no headings.");
		expect(draft).toContain("## Next Steps");
		expect(draft).toContain("## Critical Context");
	});

	it("normalizes alternate compact summary sections into sensible progress buckets", () => {
		const draft = buildHandoffDraftFromModelText({
			goal: "review if this worked.",
			modelText: [
				"### Goal",
				"Verify whether the compaction continuity work is working.",
				"",
				"### What was done",
				"- Inspected repo state and reviewed scratchpad context.",
				"- Ran targeted tests for compaction behavior.",
				"- Corrected an initial malformed test command (--run duplication), then reran correctly.",
				"- Executed repo-wide validation (npm run check).",
				"- Checked working tree cleanliness (git status --short).",
				"",
				"### Evidence",
				"- Command run (focused tests): npm test -w @kennyfrc/mu-coding-agent -- compaction-checkpoint.test.ts compaction-adapter.test.ts",
				"- Focused test output: 2 files / 8 tests passed.",
				"- Repo-wide check output: npm run check completed successfully.",
				"- Git status: clean (no modified files).",
				"",
				"### Outcome",
				"The implemented compaction continuity flow is currently passing validation and appears to work as intended, with no code changes required at this point.",
				"",
				"### Suggested follow-up (optional)",
				"- Perform a deeper manual/live-flow audit of the full compaction path.",
			].join("\n"),
			readFiles: [],
			modifiedFiles: [],
		});

		expect(draft).toContain("## Goal");
		expect(draft).toContain("Verify whether the compaction continuity work is working.");
		expect(draft).toContain("### Done");
		expect(draft).toContain("- Inspected repo state and reviewed scratchpad context.");
		expect(draft).toContain("- Ran targeted tests for compaction behavior.");
		expect(draft).toContain(
			"- The implemented compaction continuity flow is currently passing validation and appears to work as intended, with no code changes required at this point.",
		);
		expect(draft).toContain("### In Progress");
		expect(draft).toContain("- [ ] Perform a deeper manual/live-flow audit of the full compaction path.");
		expect(draft).toContain("### Blocked\n- (none)");
		expect(draft).toContain("## Critical Context");
		expect(draft).toContain("- Git status: clean (no modified files).");
	});

	it("exposes a stable system prompt constant", () => {
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("context summarization assistant");
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("Do NOT continue the conversation");
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("Output EXACTLY these sections in this order");
	});

	it("formats file tracking tags with one path per line", () => {
		const tags = formatHandoffFileTrackingTags({ readFiles: ["a.ts", "b.ts"], modifiedFiles: ["c.ts"] });
		expect(tags).toContain("<read-files>");
		expect(tags).toContain("a.ts");
		expect(tags).toContain("b.ts");
		expect(tags).toContain("</read-files>");
		expect(tags).toContain("<modified-files>");
		expect(tags).toContain("c.ts");
		expect(tags).toContain("</modified-files>");
	});
});
