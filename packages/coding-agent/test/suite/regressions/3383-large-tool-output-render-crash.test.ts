import { describe, expect, it } from "vitest";
import { sanitizeBinaryOutput } from "../../../src/utils/shell.js";

describe("issue #3383 large tool output render crash", () => {
	it("does not throw on very large text payloads", () => {
		const huge = "a".repeat(2 ** 28);
		expect(() => sanitizeBinaryOutput(huge)).not.toThrow();
		expect(sanitizeBinaryOutput(huge).length).toBe(huge.length);
	});

	it("sanitizes control chars, lone surrogates, and dangerous format chars", () => {
		const dirty = `A${String.fromCharCode(0)}B${String.fromCharCode(0xd800)}C\ufff9D\n\t\r`;
		expect(sanitizeBinaryOutput(dirty)).toBe("ABCD\n\t\r");
	});

	it("accepts non-string values defensively", () => {
		expect(sanitizeBinaryOutput(123)).toBe("123");
		expect(sanitizeBinaryOutput(null)).toBe("");
	});
});
