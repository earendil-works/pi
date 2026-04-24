import { describe, expect, test } from "vitest";
import { getAuthSelectorIndicator } from "../src/modes/interactive/components/auth-selector-status.js";

describe("getAuthSelectorIndicator", () => {
	test("shows subscription configured when oauth matches the selector", () => {
		expect(
			getAuthSelectorIndicator("oauth", {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			}),
		).toEqual({ kind: "configured", label: "subscription configured" });
	});

	test("shows api key configured in the subscription selector when an api key is stored", () => {
		expect(
			getAuthSelectorIndicator("oauth", {
				type: "api_key",
				key: "sk-test",
			}),
		).toEqual({ kind: "configured-other", label: "api key configured" });
	});

	test("shows api key configured when api key auth matches the selector", () => {
		expect(
			getAuthSelectorIndicator("api_key", {
				type: "api_key",
				key: "sk-test",
			}),
		).toEqual({ kind: "configured", label: "api key configured" });
	});

	test("shows subscription configured in the api key selector when oauth is stored", () => {
		expect(
			getAuthSelectorIndicator("api_key", {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			}),
		).toEqual({ kind: "configured-other", label: "subscription configured" });
	});

	test("keeps env api key hints in the api key selector", () => {
		expect(
			getAuthSelectorIndicator("api_key", undefined, {
				configured: false,
				source: "environment",
				label: "ANTHROPIC_API_KEY",
			}),
		).toEqual({ kind: "environment", label: "ANTHROPIC_API_KEY" });
	});

	test("ignores api key env hints in the subscription selector", () => {
		expect(
			getAuthSelectorIndicator("oauth", undefined, {
				configured: false,
				source: "environment",
				label: "ANTHROPIC_API_KEY",
			}),
		).toEqual({ kind: "unconfigured" });
	});
});
