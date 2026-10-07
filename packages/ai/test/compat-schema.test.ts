import type { Static } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	AnthropicMessagesCompatSchema,
	BedrockCompatSchema,
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	ProviderCompatSchema,
} from "../src/providers/compat-schema.ts";

type ProviderCompat = Static<typeof ProviderCompatSchema>;

describe("compatibility schemas", () => {
	it("preserves property types in the provider superset", () => {
		expectTypeOf<ProviderCompat["supportsStore"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<ProviderCompat["sessionAffinityFormat"]>().toEqualTypeOf<
			"openai" | "openai-nosession" | "openrouter" | undefined
		>();
	});

	it("preserves API-specific defaults", () => {
		expect(Compile(OpenAICompletionsCompatSchema).Default({})).not.toHaveProperty("thinkingFormat");
		expect(Compile(OpenAIResponsesCompatSchema).Default({})).toMatchObject({ supportsDeveloperRole: true });
		expect(Compile(AnthropicMessagesCompatSchema).Default({})).toMatchObject({
			sendSessionAffinityHeaders: false,
		});
		expect(Compile(BedrockCompatSchema).Default({})).toMatchObject({ supportsStrictMode: false });
	});

	it("does not assign API-specific defaults to the provider superset", () => {
		const defaults = Compile(ProviderCompatSchema).Default({});
		expect(defaults).not.toHaveProperty("supportsDeveloperRole");
		expect(defaults).not.toHaveProperty("sendSessionAffinityHeaders");
		expect(defaults).not.toHaveProperty("supportsLongCacheRetention");
		expect(defaults).not.toHaveProperty("supportsStrictMode");
	});
});
