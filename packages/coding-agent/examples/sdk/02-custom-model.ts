/**
 * Custom Model Selection
 *
 * Shows how to select a specific model and thinking level.
 */

import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, createAgentSession, ModelRegistry } from "@mariozechner/pi-coding-agent";

// Set up auth storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Option 1: Find a specific built-in model by provider/id
const opus = getModel("anthropic", "claude-opus-4-5");
if (opus) {
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

// Option 2: Find model via registry (includes custom models from models.json)
const customModel = modelRegistry.find("my-provider", "my-model");
if (customModel) {
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

// Option 3: Pick from available models (have valid API keys)
const available = await modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map((m) => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { session } = await createAgentSession({
		model: available[0],
		thinkingLevel: "medium", // off, low, medium, high
		authStorage,
		modelRegistry,
	});

	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("Say hello in one sentence.");
	console.log();
}
