import { describe, expect, it } from "vitest";
import { resolveConfiguredApiKey } from "../src/core/provider-api-key.ts";

describe("registerProvider apiKey function", () => {
	it("reads a plugin auth-file key at request time", () => {
		expect(resolveConfiguredApiKey(() => "from-plugin-auth-file")).toBe("from-plugin-auth-file");
		expect(resolveConfiguredApiKey(() => undefined)).toBeUndefined();
		expect(resolveConfiguredApiKey("literal")).toBe("literal");
		expect(resolveConfiguredApiKey(undefined)).toBeUndefined();
	});
});
