/**
 * Local benchmark helper for the /model selector hot path.
 *
 * Not a vitest test (file name is not *.test.ts).
 * Run from repo root:
 *   npx tsx packages/coding-agent/test/bench-model-selector.ts
 */

import type { Api, Model } from "@kennyfrc/mu-ai";

import { getAvailableModels } from "../src/model-config.js";
import { compareModelUsage, getWorkspaceSessionDir, loadModelUsageStats } from "../src/model-usage.js";

type ModelItem = { provider: string; id: string; model: Model<Api> };

function forceNoNetworkApiKeyResolution(): void {
	// Ensure we don't hit OAuth refresh network paths during benchmarking.
	// (We only care about selector-local performance, not auth.)
	process.env.ANTHROPIC_OAUTH_TOKEN ||= "dummy";
	process.env.OPENAI_API_KEY ||= "dummy";
	process.env.GEMINI_API_KEY ||= "dummy";
	process.env.OPENROUTER_API_KEY ||= "dummy";
	process.env.GROQ_API_KEY ||= "dummy";
	process.env.CEREBRAS_API_KEY ||= "dummy";
	process.env.XAI_API_KEY ||= "dummy";
	process.env.MOONSHOT_API_KEY ||= "dummy";
	process.env.ZAI_API_KEY ||= "dummy";
}

async function main(): Promise<void> {
	forceNoNetworkApiKeyResolution();

	const sessionDir = getWorkspaceSessionDir();
	console.log("sessionDir:", sessionDir);

	console.time("loadModelUsageStats#1");
	const usage1 = loadModelUsageStats(sessionDir);
	console.timeEnd("loadModelUsageStats#1");
	console.log("usage keys:", usage1.size);

	console.time("loadModelUsageStats#2");
	const usage2 = loadModelUsageStats(sessionDir);
	console.timeEnd("loadModelUsageStats#2");
	console.log("usage keys:", usage2.size);

	console.time("getAvailableModels");
	const { models, error } = await getAvailableModels();
	console.timeEnd("getAvailableModels");
	if (error) throw new Error(error);

	console.log("available models:", models.length);

	const items: ModelItem[] = models.map((model) => ({ provider: model.provider, id: model.id, model }));

	console.time("sort(recency)");
	items.sort((a, b) => compareModelUsage(a, b, usage2, "recency"));
	console.timeEnd("sort(recency)");
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
