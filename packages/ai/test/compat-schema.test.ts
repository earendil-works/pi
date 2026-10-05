import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	AnthropicMessagesCompatSchema,
	BedrockCompatSchema,
	OpenAIResponsesCompatSchema,
	ProviderCompatSchema,
} from "../src/providers/compat-schema.ts";

describe("compatibility schemas", () => {
	it("preserves API-specific defaults", () => {
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
		expect(defaults).not.toHaveProperty("supportsStrictMode");
	});
});
