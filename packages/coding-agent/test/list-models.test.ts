import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

function createFauxModel(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider">): Model<Api> {
	return {
		name: overrides.id,
		api: "openai-completions",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	} as Model<Api>;
}

function createFakeModelRuntime(models: Model<Api>[]): ModelRuntime {
	return {
		getError: () => undefined,
		getAvailable: async () => models,
	} as unknown as ModelRuntime;
}

describe("listModels", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let output: string[];

	beforeEach(() => {
		output = [];
		logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
			output.push(line);
		});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("shows a default->extended context range for models with an extended context window", async () => {
		const runtime = createFakeModelRuntime([
			createFauxModel({
				id: "claude-sonnet-5",
				provider: "github-copilot",
				contextWindow: 200000,
				extendedContextWindow: 1000000,
			}),
		]);

		await listModels(runtime);

		const row = output.find((line) => line.includes("claude-sonnet-5"));
		expect(row).toContain("200K->1M");
	});

	it("shows a plain context size for models without an extended context window", async () => {
		const runtime = createFakeModelRuntime([
			createFauxModel({ id: "gpt-4.1", provider: "github-copilot", contextWindow: 128000 }),
		]);

		await listModels(runtime);

		const row = output.find((line) => line.includes("gpt-4.1"));
		expect(row).toContain("128K");
		expect(row).not.toContain("->");
	});
});
