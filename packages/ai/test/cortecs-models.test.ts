import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { cortecsProvider } from "../src/providers/cortecs.ts";

function fakeAuthContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

describe("Cortecs provider", () => {
	it("exposes the generated OpenAI Responses catalog", () => {
		const provider = cortecsProvider();
		const model = getBuiltinModel("cortecs", "glm-5.2");

		expect(provider.id).toBe("cortecs");
		expect(provider.name).toBe("Cortecs");
		expect(provider.getModels().length).toBeGreaterThan(0);
		expect(model).toMatchObject({
			id: "glm-5.2",
			api: "openai-responses",
			provider: "cortecs",
			baseUrl: "https://api.cortecs.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			compat: { supportsLongCacheRetention: false },
		});
	});

	it("resolves CORTECS_API_KEY", async () => {
		const models = createModels({ authContext: fakeAuthContext({ CORTECS_API_KEY: "cortecs-key" }) });
		models.setProvider(cortecsProvider());

		expect(await models.getAuth("cortecs")).toEqual({
			auth: { apiKey: "cortecs-key" },
			source: "CORTECS_API_KEY",
		});
	});
});
