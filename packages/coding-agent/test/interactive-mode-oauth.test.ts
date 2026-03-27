import { describe, expect, it } from "vitest";
import { normalizeOpenAICodexAuthFlowSelection } from "../src/modes/interactive/interactive-mode.js";

describe("normalizeOpenAICodexAuthFlowSelection", () => {
	it("maps headless and device to device flow", () => {
		expect(normalizeOpenAICodexAuthFlowSelection("headless")).toBe("device");
		expect(normalizeOpenAICodexAuthFlowSelection("device")).toBe("device");
	});

	it("maps browser and callback to callback flow", () => {
		expect(normalizeOpenAICodexAuthFlowSelection("browser")).toBe("callback");
		expect(normalizeOpenAICodexAuthFlowSelection("callback")).toBe("callback");
	});
});
