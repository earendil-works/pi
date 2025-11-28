import {
	type AgentContext,
	type AgentLoopConfig,
	agentLoop,
	type Message,
	type UserMessage,
} from "@mariozechner/pi-ai";
import { getAppStorage } from "../../storage/app-storage.js";
import { applyProxyIfNeeded } from "../../utils/proxy-utils.js";
import type { AgentRunConfig, AgentTransport } from "./types.js";

/**
 * Transport that calls LLM providers directly.
 * Uses CORS proxy only for providers that require it (Anthropic OAuth, Z-AI).
 */
export class ProviderTransport implements AgentTransport {
	async *run(messages: Message[], userMessage: Message, cfg: AgentRunConfig, signal?: AbortSignal) {
		// Get API key from storage
		const apiKey = await getAppStorage().providerKeys.get(cfg.model.provider);
		if (!apiKey) {
			throw new Error("no-api-key");
		}

		// Get proxy URL from settings (if available)
		const proxyEnabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
		const proxyUrl = await getAppStorage().settings.get<string>("proxy.url");

		// Apply proxy only if this provider/key combination requires it
		const model = applyProxyIfNeeded(cfg.model, apiKey, proxyEnabled ? proxyUrl || undefined : undefined);

		// Messages are already LLM-compatible (filtered by Agent)
		const context: AgentContext = {
			systemPrompt: cfg.systemPrompt,
			messages,
			tools: cfg.tools,
		};

		const pc: AgentLoopConfig = {
			model,
			reasoning: cfg.reasoning,
			apiKey,
		};

		// Yield events from agentLoop
		for await (const ev of agentLoop(userMessage as unknown as UserMessage, context, pc, signal)) {
			yield ev;
		}
	}
}
