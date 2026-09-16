import { FinishReason } from "@google/genai";
import { describe, expect, it } from "vitest";
import { mapStopReason, mapStopReasonString } from "../src/api/google-shared.ts";

describe("Google stop reasons", () => {
	// #9488: the merged branch must handle all finish reasons in the pinned SDK.
	it.each(Object.values(FinishReason))("maps SDK finish reason %s consistently with raw responses", (reason) => {
		expect(mapStopReason(reason)).toBe(mapStopReasonString(reason));
	});
});
