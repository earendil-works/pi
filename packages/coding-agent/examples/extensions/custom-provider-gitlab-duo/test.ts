/**
 * Test script for GitLab Duo extension
 * Run: npx tsx test.ts [model-id] [--thinking]
 *
 * Examples:
 *   npx tsx test.ts                              # Test default (claude-sonnet-4-5-20250929)
 *   npx tsx test.ts gpt-5-codex                  # Test GPT-5 Codex
 *   npx tsx test.ts claude-sonnet-4-5-20250929 --thinking
 */

import { type Api, type Context, type Model, registerApiProvider, streamSimple } from "@mariozechner/pi-ai";
import { readFileSync } from "fs";
import { getAgentDir } from "packages/coding-agent/src/config.js";
import { join } from "path";
import { MODELS, streamGitLabDuo } from "./index.js";

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

async function main() {
	const modelId = process.argv[2] || "claude-sonnet-4-5-20250929";
	const useThinking = process.argv.includes("--thinking");

	const cfg = MODEL_MAP.get(modelId);
	if (!cfg) {
		console.error(`Unknown model: ${modelId}`);
		console.error("Available:", MODELS.map((m) => m.id).join(", "));
		process.exit(1);
	}

	// Read auth
	const authPath = join(getAgentDir(), "extensions", "auth.json");
	const authData = JSON.parse(readFileSync(authPath, "utf-8"));
	const gitlabCred = authData["gitlab-duo"];
	if (!gitlabCred?.access) {
		console.error("No gitlab-duo credentials. Run /login gitlab-duo first.");
		process.exit(1);
	}

	// Register provider
	registerApiProvider({
		api: "gitlab-duo-api" as Api,
		stream: streamGitLabDuo,
		streamSimple: streamGitLabDuo,
	});

	// Create model
	const model: Model<Api> = {
		id: cfg.id,
		name: cfg.name,
		api: "gitlab-duo-api" as Api,
		provider: "gitlab-duo",
		baseUrl: cfg.baseUrl,
		reasoning: cfg.reasoning,
		input: cfg.input,
		cost: cfg.cost,
		contextWindow: cfg.contextWindow,
		maxTokens: cfg.maxTokens,
	};

	const context: Context = {
		messages: [{ role: "user", content: "Say hello in exactly 3 words.", timestamp: Date.now() }],
	};

	console.log(`Model: ${model.id}, Backend: ${cfg.backend}, Thinking: ${useThinking}`);

	const stream = streamSimple(model, context, {
		apiKey: gitlabCred.access,
		maxTokens: 100,
		reasoning: useThinking ? "low" : undefined,
	});

	for await (const event of stream) {
		if (event.type === "thinking_start") console.log("[Thinking]");
		else if (event.type === "thinking_delta") process.stdout.write(event.delta);
		else if (event.type === "thinking_end") console.log("\n[/Thinking]\n");
		else if (event.type === "text_delta") process.stdout.write(event.delta);
		else if (event.type === "error") console.error("\nError:", event.error.errorMessage);
		else if (event.type === "done") console.log("\n\nDone!", event.reason, event.message.usage);
	}
}

main().catch(console.error);
