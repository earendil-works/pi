import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import { MODELS } from "../src/models.generated.ts";
import type { Model } from "../src/types.ts";

describe.skipIf(!process.env.OPENCODE_API_KEY)("OpenCode Models Smoke Test", () => {
	const providers = [
		{ key: "opencode", label: "OpenCode Zen" },
		{ key: "opencode-go", label: "OpenCode Go" },
	] as const;

	providers.forEach(({ key, label }) => {
		const providerModels = Object.values(MODELS[key]);
		providerModels.forEach((model) => {
			it(`${label}: ${model.id}`, async () => {
				const response = await complete(model as Model<any>, {
					messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
				});

				expect(response.content).toBeTruthy();
				expect(response.stopReason).toBe("stop");
			}, 60000);
		});
	});
});
