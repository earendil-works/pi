import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

describe("issue #7269 CLI end-of-options delimiter", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it.each(["- summarize the following points for me", "--answer my question briefly"])(
		"passes %j as a prompt after --",
		async (prompt) => {
			const parsed = parseArgs(["-ne", "--no-session", "-p", "--", prompt]);
			expect(parsed.messages).toEqual([prompt]);
			expect(parsed.unknownFlags.size).toBe(0);
			expect(parsed.diagnostics).toEqual([]);

			harness = await createHarness();
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt(parsed.messages[0]);
			expect(getUserTexts(harness)).toEqual([prompt]);
		},
	);

	it("stops parsing options while retaining @file handling", () => {
		const parsed = parseArgs(["--unknown-flag", "value", "--", "--provider", "openai", "-c", "@prompt.md"]);

		expect(parsed.unknownFlags.get("unknown-flag")).toBe("value");
		expect(parsed.provider).toBeUndefined();
		expect(parsed.continue).toBeUndefined();
		expect(parsed.messages).toEqual(["--provider", "openai", "-c"]);
		expect(parsed.fileArgs).toEqual(["prompt.md"]);
		expect(parsed.diagnostics).toEqual([]);
	});
});
