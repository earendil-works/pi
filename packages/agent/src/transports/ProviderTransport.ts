import { type AgentContext, type AgentLoopConfig, agentLoop, type Message, type UserMessage } from "@kennyfrc/mu-ai";
import type { AgentRunConfig, AgentTransport } from "./types.js";

export interface ProviderTransportOptions {
	/**
	 * Function to retrieve API key for a given provider.
	 * If not provided, transport will try to use environment variables.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Optional CORS proxy URL for browser environments.
	 * If provided, all requests will be routed through this proxy.
	 * Format: "https://proxy.example.com"
	 */
	corsProxyUrl?: string;
}

/**
 * Transport that calls LLM providers directly.
 * Optionally routes calls through a CORS proxy if configured.
 */
export class ProviderTransport implements AgentTransport {
	private options: ProviderTransportOptions;

	constructor(options: ProviderTransportOptions = {}) {
		this.options = options;
	}

	async *run(messages: Message[], userMessage: Message, cfg: AgentRunConfig, signal?: AbortSignal) {
		// Get API key
		let apiKey: string | undefined;
		if (this.options.getApiKey) {
			apiKey = await this.options.getApiKey(cfg.model.provider);
		}

		if (!apiKey) {
			throw new Error(`No API key found for provider: ${cfg.model.provider}`);
		}

		// Clone model and modify baseUrl if CORS proxy is enabled
		let model = cfg.model;
		if (this.options.corsProxyUrl && cfg.model.baseUrl) {
			model = {
				...cfg.model,
				baseUrl: `${this.options.corsProxyUrl}/?url=${encodeURIComponent(cfg.model.baseUrl)}`,
			};
		}

		// Messages are already LLM-compatible (filtered by Agent)
		const context: AgentContext = {
			systemPrompt: cfg.systemPrompt,
			messages,
			tools: cfg.tools,
		};

		const pc: AgentLoopConfig = {
			model,
			reasoning: cfg.reasoning,
			fastMode: cfg.fastMode,
			apiKey,
			preprocessor: cfg.preprocessor,
			interrupt: cfg.interrupt,
			toolResultTransformer: cfg.toolResultTransformer,
		};

		// Yield events from agentLoop
		for await (const ev of agentLoop(userMessage as unknown as UserMessage, context, pc, signal)) {
			yield ev;
		}
	}
}
