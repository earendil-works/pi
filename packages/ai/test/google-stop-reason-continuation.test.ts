import { FinishReason } from "@google/genai";
import { describe, expect, it } from "vitest";
import { mapStopReason, mapStopReasonString } from "../src/api/google-shared.ts";

describe("Google CONTINUATION finish reason", () => {
	// #12097: @google/genai 2.32.0, needed for httpOptions.fetch, adds FinishReason.CONTINUATION.
	it("maps CONTINUATION to length, like MAX_TOKENS", () => {
		expect(mapStopReason(FinishReason.CONTINUATION)).toBe("length");
		expect(mapStopReasonString("CONTINUATION")).toBe("length");
	});
});
