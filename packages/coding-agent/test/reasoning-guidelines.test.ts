import type { ThinkingLevel } from "@kennyfrc/mu-agent-core";
import { describe, expect, it } from "vitest";
import { getReasoningGuidelines } from "../src/prompts/index.js";

describe("getReasoningGuidelines", () => {
	it("returns null for off", () => {
		expect(getReasoningGuidelines("off")).toBeNull();
	});

	it("returns correct XML block for minimal", () => {
		const result = getReasoningGuidelines("minimal");
		expect(result).not.toBeNull();
		expect(result).toContain("<reasoning_guidelines>");
		expect(result).toContain("</reasoning_guidelines>");
		expect(result).toContain("1000");
	});

	it("returns correct XML block for low", () => {
		const result = getReasoningGuidelines("low");
		expect(result).not.toBeNull();
		expect(result).toContain("2000");
	});

	it("returns correct XML block for medium", () => {
		const result = getReasoningGuidelines("medium");
		expect(result).not.toBeNull();
		expect(result).toContain("8000");
	});

	it("returns correct XML block for high", () => {
		const result = getReasoningGuidelines("high");
		expect(result).not.toBeNull();
		expect(result).toContain("16000");
	});

	it("returns correct XML block for xhigh", () => {
		const result = getReasoningGuidelines("xhigh");
		expect(result).not.toBeNull();
		expect(result).toContain("32000");
	});

	it("includes instruction to keep reasoning concise", () => {
		const result = getReasoningGuidelines("medium");
		expect(result).toContain("Keep your reasoning concise");
	});

	it("includes instruction to proceed directly", () => {
		const result = getReasoningGuidelines("medium");
		expect(result).toContain("Proceed directly through reasoning");
	});

	it("returns null for all off-like inputs", () => {
		expect(getReasoningGuidelines("off")).toBeNull();
	});
});
