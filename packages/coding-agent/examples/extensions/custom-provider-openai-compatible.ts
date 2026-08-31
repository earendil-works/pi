/**
 * OpenAI-Compatible Provider Extension
 *
 * Demonstrates registering a custom provider WITHOUT writing any streaming
 * code: pi-ai's built-in `openai-completions` API is reused, so the provider
 * only needs a base URL, an API key, and model metadata.
 *
 * This is the recommended path for OpenAI-compatible gateways/proxies
 * (vLLM, Ollama, LM Studio, cloud AI gateways, etc.).
 *
 * Usage:
 *   MY_GATEWAY_API_KEY=sk-... pi -e ./packages/coding-agent/examples/extensions/custom-provider-openai-compatible.ts
 *   # Then /model to select my-gateway/<model-id>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("my-gateway", {
		name: "My OpenAI-Compatible Gateway",
		baseUrl: "https://gateway.example.com/v1",
		apiKey: "$MY_GATEWAY_API_KEY",
		// Reuse pi-ai's built-in chat completions implementation. Other built-in
		// options include "openai-responses", "anthropic-messages", "mistral-conversations".
		api: "openai-completions",
		authHeader: true,
		models: [
			{
				id: "my-model",
				name: "My Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	});
}
