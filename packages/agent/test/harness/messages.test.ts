import type { SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { convertToLlm } from "../../src/harness/messages.ts";

describe("convertToLlm", () => {
	test("preserves system messages", () => {
		const message: SystemMessage = {
			role: "system",
			content: "Follow these instructions.",
			timestamp: 1,
		};

		expect(convertToLlm([message])).toEqual([message]);
	});
});
