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
			"## What's Done",
			"- Investigated failures.",
			"",
			"## What's Not Yet Done",
			"- Apply fix.",
			"",
			"## Learnings / Insights so Far",
			"- Root cause is X.",
			"",
			"## Next Steps",
			"- Implement Y.",
		].join("\n");

		const draft = buildHandoffDraftFromModelText({
			goal: "Fix failing tests",
			modelText,
			readFiles: ["a.ts"],
			modifiedFiles: ["b.ts"],
		});

		expect(draft).toContain("## Guide Questions");
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
		expect(draft).toContain("## What's Done");
		expect(draft).toContain("## What's Not Yet Done");
		expect(draft).toContain("## Learnings / Insights so Far");
		expect(draft).toContain("Just a paragraph, no headings.");
		expect(draft).toContain("## Next Steps");
	});

	it("exposes a stable system prompt constant", () => {
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("## Goal");
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("## What's Done");
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("## What's Not Yet Done");
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("## Learnings / Insights so Far");
		expect(HANDOFF_SUMMARY_SYSTEM_PROMPT).toContain("## Next Steps");
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
