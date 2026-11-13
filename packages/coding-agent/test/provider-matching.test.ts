import { describe, expect, test } from "vitest";
import { findMatchingProviders } from "../src/core/provider-matching.ts";

const providers = [
	{ id: "first", name: "Shared Name", authType: "oauth" },
	{ id: "first", name: "Shared Name", authType: "api_key" },
	{ id: "other", name: "FIRST", authType: "api_key" },
	{ id: "second", name: "Second Provider", authType: "oauth" },
];

describe("provider reference matching", () => {
	test("matches IDs and display names case-insensitively with surrounding whitespace", () => {
		expect(findMatchingProviders(providers, "  sEcOnD  ")).toEqual([providers[3]]);
		expect(findMatchingProviders(providers, "\tSECOND PROVIDER\n")).toEqual([providers[3]]);
	});

	test("keeps all matching providers and auth methods in input order", () => {
		const matched = findMatchingProviders(providers, "first");
		expect(matched).toEqual(providers.slice(0, 3));
		expect(matched[0]).toBe(providers[0]);
		expect(matched[1]?.authType).toBe("api_key");
		expect(findMatchingProviders(providers, "shared name")).toEqual(providers.slice(0, 2));
	});

	test("does not fuzzy-match unknown or partial references", () => {
		expect(findMatchingProviders(providers, "unknown")).toEqual([]);
		expect(findMatchingProviders(providers, "sec")).toEqual([]);
		expect(findMatchingProviders([], "first")).toEqual([]);
	});

	test("never matches an empty reference, even against empty display names", () => {
		expect(findMatchingProviders([{ id: "unnamed", name: "" }], "")).toEqual([]);
		expect(findMatchingProviders(providers, " \t ")).toEqual([]);
	});
});
