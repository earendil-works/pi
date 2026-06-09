import { describe, it, expect } from "vitest";
import { normalizeOptions } from "../ask_user_question.ts";

describe("normalizeOptions", () => {
	it("handles standard array of {label, description}", () => {
		const input = [{ label: "A", description: "a" }];
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: "a" }]);
	});

	it("unwraps single-level {item: [...]} wrapper", () => {
		const input = { item: [{ label: "A", description: "a" }] };
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: "a" }]);
	});

	it("recursively unwraps {item: {item: [...]}}", () => {
		const input = { item: { item: [{ label: "A", description: "a" }] } };
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: "a" }]);
	});

	it("recursively unwraps {item: {item: {item: [...]}}}", () => {
		const input = { item: { item: { item: [{ label: "A" }] } } };
		expect(normalizeOptions(input)).toEqual([{ label: "A" }]);
	});

	it("treats missing description as undefined (does not throw)", () => {
		const input = [{ label: "A" }];
		expect(normalizeOptions(input)).toEqual([{ label: "A", description: undefined }]);
	});

	it("returns [] for empty array", () => {
		expect(normalizeOptions([])).toEqual([]);
	});

	it("returns [] for null", () => {
		expect(normalizeOptions(null)).toEqual([]);
	});

	it("returns [] for undefined", () => {
		expect(normalizeOptions(undefined)).toEqual([]);
	});
});
