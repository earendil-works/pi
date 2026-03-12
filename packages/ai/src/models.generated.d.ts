export declare const MODELS: {
	readonly openai: {
		readonly "gpt-5-chat-latest": {
			id: string;
			name: string;
			api: "openai-responses";
			provider: string;
			baseUrl: string;
			reasoning: false;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.1-codex": {
			id: string;
			name: string;
			api: "openai-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.4": {
			id: string;
			name: string;
			api: "openai-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
	};
	readonly xai: {
		readonly "grok-code-fast-1": {
			id: string;
			name: string;
			api: "openai-completions";
			provider: string;
			baseUrl: string;
			reasoning: false;
			input: "text"[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
	};
	readonly openrouter: {
		readonly "openrouter/auto": {
			id: string;
			name: string;
			api: "openai-completions";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
	};
	readonly moonshot: {
		readonly "kimi-k2.5": {
			id: string;
			name: string;
			api: "openai-completions";
			provider: string;
			baseUrl: string;
			reasoning: true;
			reasoningFormat: "reasoning_content";
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
			extraBody: {
				thinking: {
					type: string;
				};
				temperature: number;
				top_p: number;
				n: number;
				presence_penalty: number;
				frequency_penalty: number;
			};
		};
	};
	readonly "google-gemini-cli": {
		readonly "gemini-2.5-pro": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-2.5-flash": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-2.0-flash": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: false;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-3-pro-preview": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-3-flash-preview": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-3.1-pro-preview": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
	};
	readonly "google-antigravity": {
		readonly "gemini-3-pro-high": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-3-pro-low": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-3-flash": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gemini-3.5-flash": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "claude-sonnet-4-5": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-oss-120b": {
			id: string;
			name: string;
			api: "google-gemini-cli";
			provider: string;
			baseUrl: string;
			reasoning: false;
			input: "text"[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
	};
	readonly "openai-codex": {
		readonly "gpt-5.1": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.1-codex-max": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.1-codex-mini": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.2": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.2-codex": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.3-codex": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.3-codex-spark": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: "text"[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "gpt-5.4": {
			id: string;
			name: string;
			api: "openai-codex-responses";
			provider: string;
			baseUrl: string;
			reasoning: true;
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
	};
	readonly synthetic: {
		readonly "hf:deepseek-ai/DeepSeek-V3-0324": {
			id: string;
			name: string;
			api: "openai-completions";
			provider: string;
			baseUrl: string;
			reasoning: true;
			reasoningFormat: "reasoning_content";
			input: ("image" | "text")[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
		readonly "hf:deepseek-ai/DeepSeek-R1": {
			id: string;
			name: string;
			api: "openai-completions";
			provider: string;
			baseUrl: string;
			reasoning: true;
			reasoningFormat: "reasoning_content";
			input: "text"[];
			cost: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
			};
			contextWindow: number;
			maxTokens: number;
		};
	};
};
//# sourceMappingURL=models.generated.d.ts.map
