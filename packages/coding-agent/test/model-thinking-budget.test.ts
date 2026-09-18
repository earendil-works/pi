import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";

describe("model thinking budget configuration", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-thinking-budget-"));
	});
	afterEach(async () => rm(dir, { recursive: true, force: true }));

	async function load(config: unknown): Promise<ModelConfig> {
		const path = join(dir, "models.json");
		await writeFile(path, JSON.stringify({ providers: { "llama.cpp": config } }));
		return ModelConfig.load(path);
	}

	it.each([undefined, "shared", "adapter"] as const)("preserves full model definitions with mode %s", async (mode) => {
		const config = await load({
			api: "openai-completions",
			baseUrl: "http://localhost:8080/v1",
			models: [{ id: "custom", reasoning: true, thinkingBudgetMode: mode }],
		});
		expect(config.getError()).toBeUndefined();
		const provider = composeModelProvider("llama.cpp", createLlamaProvider().provider, config, undefined);
		expect(provider.getModels()[0].thinkingBudgetMode).toBe(mode);
	});

	it("applies overrides after discovered and extension-provided metadata", async () => {
		const controller = createLlamaProvider();
		controller.setCatalog([{ id: "local", status: { value: "loaded" } }], "http://localhost:8080");
		const config = await load({ modelOverrides: { local: { reasoning: true, thinkingBudgetMode: "adapter" } } });
		const extension: ProviderConfigInput = {
			api: "openai-completions",
			baseUrl: "http://localhost:8080/v1",
			models: [...controller.provider.getModels()],
		};
		for (const registration of [undefined, extension]) {
			const provider = composeModelProvider("llama.cpp", controller.provider, config, registration);
			expect(provider.getModels()[0]).toMatchObject({ reasoning: true, thinkingBudgetMode: "adapter" });
		}
	});

	it("preserves extension metadata and discovered metadata when only reasoning is overridden", async () => {
		const controller = createLlamaProvider();
		controller.setCatalog([{ id: "local", status: { value: "loaded" } }], "http://localhost:8080");
		const config = await load({ modelOverrides: { local: { reasoning: true } } });
		for (const registration of [undefined, { models: [...controller.provider.getModels()] }]) {
			const provider = composeModelProvider("llama.cpp", controller.provider, config, registration);
			expect(provider.getModels()[0]).toMatchObject({ reasoning: true, thinkingBudgetMode: "shared" });
		}
	});

	it.each([
		{ models: [{ id: "local", thinkingBudgetMode: "invalid" }] },
		{ modelOverrides: { local: { thinkingBudgetMode: "invalid" } } },
	])("rejects invalid budget modes in %j", async (definition) => {
		expect((await load(definition)).getError()).toContain("thinkingBudgetMode");
	});
});
