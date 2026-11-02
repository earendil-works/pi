import type { Static } from "@earendil-works/pi-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	AnthropicMessagesCompatSchema,
	BedrockCompatSchema,
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	ProviderCompatSchema,
} from "../src/providers/compat-schema.ts";

type ProviderCompat = Static<typeof ProviderCompatSchema>;

/** The `default` annotation of each property of an object schema. */
function defaults(schema: { readonly [keyword: string]: unknown }): Record<string, unknown> {
	const properties = schema.properties as Record<string, { default?: unknown }>;
	return Object.fromEntries(
		Object.entries(properties)
			.filter(([, property]) => property.default !== undefined)
			.map(([name, property]) => [name, property.default]),
	);
}

describe("compatibility schemas", () => {
	it("preserves property types in the provider superset", () => {
		expectTypeOf<ProviderCompat["supportsStore"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<ProviderCompat["sessionAffinityFormat"]>().toEqualTypeOf<
			"openai" | "openai-nosession" | "openrouter" | undefined
		>();
	});

	it("preserves API-specific defaults", () => {
		const completionsDefaults = defaults(OpenAICompletionsCompatSchema);
		expect(completionsDefaults).not.toHaveProperty("thinkingFormat");
		expect(completionsDefaults).not.toHaveProperty("supportsLongCacheRetention");
		expect(defaults(OpenAIResponsesCompatSchema)).toMatchObject({ supportsDeveloperRole: true });
		const anthropicDefaults = defaults(AnthropicMessagesCompatSchema);
		expect(anthropicDefaults).not.toHaveProperty("sendSessionAffinityHeaders");
		expect(anthropicDefaults).toMatchObject({ supportsLongCacheRetention: true });
		expect(defaults(BedrockCompatSchema)).toMatchObject({ supportsStrictMode: false });
	});

	it("does not assign API-specific defaults to the provider superset", () => {
		const providerDefaults = defaults(ProviderCompatSchema);
		expect(providerDefaults).not.toHaveProperty("supportsDeveloperRole");
		expect(providerDefaults).not.toHaveProperty("sendSessionAffinityHeaders");
		expect(providerDefaults).not.toHaveProperty("supportsLongCacheRetention");
		expect(providerDefaults).not.toHaveProperty("supportsStrictMode");
	});
});
