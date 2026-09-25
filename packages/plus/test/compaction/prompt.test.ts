/**
 * Tests for plus/src/compaction/prompt.ts — the Claude Code 9-section compact prompt port.
 * Pure module; runs under vitest like the rest of the plus suite.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { formatCompactSummary, getCompactPrompt, getCompactUserSummaryMessage } from "../../src/compaction/prompt.ts";

describe("getCompactPrompt", () => {
	it("contains all 9 required summary sections", () => {
		const prompt = getCompactPrompt();
		for (const section of [
			"Primary Request and Intent",
			"Key Technical Concepts",
			"Files and Code Sections",
			"Errors and fixes",
			"Problem Solving",
			"All user messages",
			"Pending Tasks",
			"Current Work",
			"Optional Next Step",
		]) {
			assert.ok(prompt.includes(section), `missing section: ${section}`);
		}
	});

	it("forbids tool use with the aggressive no-tools preamble and trailer", () => {
		const prompt = getCompactPrompt();
		assert.ok(prompt.includes("Respond with TEXT ONLY"));
		assert.ok(prompt.includes("Do NOT call any tools"));
		assert.ok(prompt.includes("REMINDER: Do NOT call any tools"));
	});

	it("demands an <analysis> block before the <summary>", () => {
		const prompt = getCompactPrompt();
		assert.ok(prompt.includes("<analysis>"));
		assert.ok(prompt.includes("</analysis>"));
		assert.ok(prompt.includes("<summary>"));
		assert.ok(prompt.indexOf("<analysis>") < prompt.indexOf("</example>"));
	});

	it("appends custom instructions as an Additional Instructions section", () => {
		const prompt = getCompactPrompt("Focus on the migration plan.");
		assert.ok(prompt.includes("Additional Instructions:\nFocus on the migration plan."));
		assert.ok(
			prompt.endsWith(
				"\n\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.",
			),
		);
	});

	it("ignores blank custom instructions", () => {
		const prompt = getCompactPrompt("   ");
		assert.ok(!prompt.includes("Additional Instructions"));
	});
});

describe("formatCompactSummary", () => {
	it("strips the <analysis> block and unwraps <summary> into a Summary: prefix", () => {
		const raw =
			"<analysis>thinking out loud</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   Build the thing.\n</summary>";
		const formatted = formatCompactSummary(raw);
		assert.ok(!formatted.includes("<analysis>"));
		assert.ok(!formatted.includes("thinking out loud"));
		assert.ok(formatted.startsWith("Summary:"));
		assert.ok(formatted.includes("1. Primary Request and Intent:"));
		assert.ok(formatted.includes("Build the thing."));
	});

	it("passes through plain summaries without tags", () => {
		const text = "Just a plain summary.\n\nWith two paragraphs.";
		assert.equal(formatCompactSummary(text), text);
	});

	it("collapses 3+ newlines into paragraph breaks", () => {
		assert.equal(formatCompactSummary("a\n\n\n\nb"), "a\n\nb");
	});
});

describe("getCompactUserSummaryMessage", () => {
	it("wraps the formatted summary with the continuation preamble", () => {
		const message = getCompactUserSummaryMessage("<summary>stuff</summary>");
		assert.ok(
			message.includes("This session is being continued from a previous conversation that ran out of context."),
		);
		assert.ok(message.includes("Summary:\nstuff"));
	});

	it("adds the no-questions directive for auto-compaction", () => {
		const message = getCompactUserSummaryMessage("x", true);
		assert.ok(
			message.includes(
				"Continue the conversation from where it left off without asking the user any further questions.",
			),
		);
	});

	it("omits the directive for manual compaction", () => {
		const message = getCompactUserSummaryMessage("x", false);
		assert.ok(!message.includes("Continue the conversation from where it left off"));
	});
});
