export declare const MODELS: {
	readonly anthropic: {
		readonly "claude-opus-4-0": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-5-sonnet-20241022": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-opus-4-1": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-haiku-4-5": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-5-sonnet-20240620": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-5-haiku-latest": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-opus-4-5": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-opus-20240229": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-opus-4-5-20251101": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
			api: "anthropic-messages";
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
		readonly "claude-sonnet-4-5-20250929": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-sonnet-4-20250514": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-opus-4-20250514": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-5-haiku-20241022": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-haiku-20240307": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-7-sonnet-20250219": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-7-sonnet-latest": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-sonnet-4-0": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-opus-4-1-20250805": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-3-sonnet-20240229": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "claude-haiku-4-5-20251001": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
	readonly google: {
		readonly "gemini-3-flash-preview": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-flash-preview-05-20": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-flash-lite-latest": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-3-pro-preview": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
			api: "google-generative-ai";
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
		readonly "gemini-flash-latest": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-pro-preview-05-06": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.0-flash-lite": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-live-2.5-flash-preview-native-audio": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.0-flash": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-flash-lite": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-pro-preview-06-05": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-live-2.5-flash": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-flash-lite-preview-06-17": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-flash-preview-09-2025": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-flash-preview-04-17": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-pro": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-1.5-flash": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-1.5-flash-8b": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-2.5-flash-lite-preview-09-2025": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
		readonly "gemini-1.5-pro": {
			id: string;
			name: string;
			api: "google-generative-ai";
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
	};
	readonly openai: {
		readonly "gpt-4.1-nano": {
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
		readonly "gpt-4": {
			id: string;
			name: string;
			api: "openai-responses";
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
		readonly "o1-pro": {
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
		readonly "gpt-4o-2024-05-13": {
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
		readonly "gpt-5.2-codex": {
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
		readonly "gpt-4o-2024-08-06": {
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
		readonly "gpt-4.1-mini": {
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
		readonly "o3-deep-research": {
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
		readonly "gpt-5.2-pro": {
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
		readonly "gpt-4-turbo": {
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
		readonly "gpt-5.1-codex-mini": {
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
		readonly "o3-mini": {
			id: string;
			name: string;
			api: "openai-responses";
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
		readonly "gpt-5.2-chat-latest": {
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
		readonly "gpt-5.1": {
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
		readonly "codex-mini-latest": {
			id: string;
			name: string;
			api: "openai-responses";
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
		readonly "gpt-5-nano": {
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
		readonly "gpt-5-codex": {
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
		readonly "gpt-4o": {
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
		readonly "gpt-4.1": {
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
		readonly "o4-mini": {
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
		readonly o1: {
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
		readonly "gpt-5-mini": {
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
		readonly "o3-pro": {
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
		readonly "gpt-4o-2024-11-20": {
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
		readonly "gpt-5.1-codex-max": {
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
		readonly o3: {
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
		readonly "o4-mini-deep-research": {
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
		readonly "gpt-4o-mini": {
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
		readonly "gpt-5": {
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
		readonly "gpt-5-pro": {
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
		readonly "gpt-5.2": {
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
		readonly "gpt-5.1-chat-latest": {
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
	};
	readonly groq: {
		readonly "llama-3.1-8b-instant": {
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
		readonly "mistral-saba-24b": {
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
		readonly "llama3-8b-8192": {
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
		readonly "qwen-qwq-32b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "llama3-70b-8192": {
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
		readonly "deepseek-r1-distill-llama-70b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "gemma2-9b-it": {
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
		readonly "llama-3.3-70b-versatile": {
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
		readonly "moonshotai/kimi-k2-instruct-0905": {
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
		readonly "moonshotai/kimi-k2-instruct": {
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
		readonly "openai/gpt-oss-20b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-oss-120b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-32b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "meta-llama/llama-4-scout-17b-16e-instruct": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "meta-llama/llama-4-maverick-17b-128e-instruct": {
			id: string;
			name: string;
			api: "openai-completions";
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
	};
	readonly cerebras: {
		readonly "zai-glm-4.7": {
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
		readonly "qwen-3-235b-a22b-instruct-2507": {
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
		readonly "gpt-oss-120b": {
			id: string;
			name: string;
			api: "openai-completions";
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
	};
	readonly xai: {
		readonly "grok-4-fast-non-reasoning": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-3-fast": {
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
		readonly "grok-4": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-2-vision": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-code-fast-1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-2": {
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
		readonly "grok-3-mini-fast-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-2-vision-1212": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-3": {
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
		readonly "grok-4-fast": {
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
		readonly "grok-2-latest": {
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
		readonly "grok-4-1-fast": {
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
		readonly "grok-2-1212": {
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
		readonly "grok-3-fast-latest": {
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
		readonly "grok-3-latest": {
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
		readonly "grok-2-vision-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-vision-beta": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-3-mini": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-beta": {
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
		readonly "grok-3-mini-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-4-1-fast-non-reasoning": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "grok-3-mini-fast": {
			id: string;
			name: string;
			api: "openai-completions";
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
	};
	readonly zai: {
		readonly "glm-4.7": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "glm-4.5-flash": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "glm-4.5": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "glm-4.5-air": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "glm-4.5v": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "glm-4.6": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
		readonly "glm-4.6v": {
			id: string;
			name: string;
			api: "anthropic-messages";
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
	readonly mistral: {
		readonly "devstral-medium-2507": {
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
		readonly "mistral-large-2512": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "open-mixtral-8x22b": {
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
		readonly "ministral-8b-latest": {
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
		readonly "pixtral-large-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistral-small-2506": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "devstral-2512": {
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
		readonly "ministral-3b-latest": {
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
		readonly "pixtral-12b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistral-medium-2505": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "labs-devstral-small-2512": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "devstral-medium-latest": {
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
		readonly "devstral-small-2505": {
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
		readonly "mistral-medium-2508": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistral-small-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "magistral-small": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "devstral-small-2507": {
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
		readonly "codestral-latest": {
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
		readonly "open-mixtral-8x7b": {
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
		readonly "mistral-nemo": {
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
		readonly "open-mistral-7b": {
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
		readonly "mistral-large-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistral-medium-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistral-large-2411": {
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
		readonly "magistral-medium-latest": {
			id: string;
			name: string;
			api: "openai-completions";
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
	};
	readonly openrouter: {
		readonly "z-ai/glm-4.7-flash": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-5.2-codex": {
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
		readonly "allenai/olmo-3.1-32b-instruct": {
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
		readonly "bytedance-seed/seed-1.6-flash": {
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
		readonly "bytedance-seed/seed-1.6": {
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
		readonly "minimax/minimax-m2.1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "z-ai/glm-4.7": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemini-3-flash-preview": {
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
		readonly "mistralai/mistral-small-creative": {
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
		readonly "xiaomi/mimo-v2-flash:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "xiaomi/mimo-v2-flash": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "nvidia/nemotron-3-nano-30b-a3b:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "nvidia/nemotron-3-nano-30b-a3b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-5.2-chat": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-5.2-pro": {
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
		readonly "openai/gpt-5.2": {
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
		readonly "mistralai/devstral-2512:free": {
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
		readonly "mistralai/devstral-2512": {
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
		readonly "relace/relace-search": {
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
		readonly "z-ai/glm-4.6v": {
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
		readonly "nex-agi/deepseek-v3.1-nex-n1": {
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
		readonly "openai/gpt-5.1-codex-max": {
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
		readonly "amazon/nova-2-lite-v1": {
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
		readonly "mistralai/ministral-14b-2512": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/ministral-8b-2512": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/ministral-3b-2512": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/mistral-large-2512": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "arcee-ai/trinity-mini:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "arcee-ai/trinity-mini": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepseek/deepseek-v3.2": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "prime-intellect/intellect-3": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "tngtech/tng-r1t-chimera:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "tngtech/tng-r1t-chimera": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "anthropic/claude-opus-4.5": {
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
		readonly "x-ai/grok-4.1-fast": {
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
		readonly "google/gemini-3-pro-preview": {
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
		readonly "openai/gpt-5.1": {
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
		readonly "openai/gpt-5.1-chat": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-5.1-codex": {
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
		readonly "openai/gpt-5.1-codex-mini": {
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
		readonly "kwaipilot/kat-coder-pro": {
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
		readonly "moonshotai/kimi-k2-thinking": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "amazon/nova-premier-v1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/voxtral-small-24b-2507": {
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
		readonly "openai/gpt-oss-safeguard-20b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "nvidia/nemotron-nano-12b-v2-vl:free": {
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
		readonly "minimax/minimax-m2": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepcogito/cogito-v2-preview-llama-405b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-5-image-mini": {
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
		readonly "anthropic/claude-haiku-4.5": {
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
		readonly "qwen/qwen3-vl-8b-thinking": {
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
		readonly "qwen/qwen3-vl-8b-instruct": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-5-image": {
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
		readonly "openai/o3-deep-research": {
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
		readonly "openai/o4-mini-deep-research": {
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
		readonly "nvidia/llama-3.3-nemotron-super-49b-v1.5": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-vl-30b-a3b-thinking": {
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
		readonly "qwen/qwen3-vl-30b-a3b-instruct": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-5-pro": {
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
		readonly "z-ai/glm-4.6": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "z-ai/glm-4.6:exacto": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "anthropic/claude-sonnet-4.5": {
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
		readonly "deepseek/deepseek-v3.2-exp": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemini-2.5-flash-preview-09-2025": {
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
		readonly "google/gemini-2.5-flash-lite-preview-09-2025": {
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
		readonly "qwen/qwen3-vl-235b-a22b-thinking": {
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
		readonly "qwen/qwen3-vl-235b-a22b-instruct": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-max": {
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
		readonly "qwen/qwen3-coder-plus": {
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
		readonly "openai/gpt-5-codex": {
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
		readonly "deepseek/deepseek-v3.1-terminus:exacto": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepseek/deepseek-v3.1-terminus": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "x-ai/grok-4-fast": {
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
		readonly "alibaba/tongyi-deepresearch-30b-a3b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-coder-flash": {
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
		readonly "qwen/qwen3-next-80b-a3b-thinking": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-next-80b-a3b-instruct:free": {
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
		readonly "qwen/qwen3-next-80b-a3b-instruct": {
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
		readonly "qwen/qwen-plus-2025-07-28": {
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
		readonly "qwen/qwen-plus-2025-07-28:thinking": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "nvidia/nemotron-nano-9b-v2:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "nvidia/nemotron-nano-9b-v2": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "moonshotai/kimi-k2-0905": {
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
		readonly "moonshotai/kimi-k2-0905:exacto": {
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
		readonly "deepcogito/cogito-v2-preview-llama-70b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepcogito/cogito-v2-preview-llama-109b-moe": {
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
		readonly "stepfun-ai/step3": {
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
		readonly "qwen/qwen3-30b-a3b-thinking-2507": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "x-ai/grok-code-fast-1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "nousresearch/hermes-4-70b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepseek/deepseek-chat-v3.1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-4o-audio-preview": {
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
		readonly "mistralai/mistral-medium-3.1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "baidu/ernie-4.5-21b-a3b": {
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
		readonly "baidu/ernie-4.5-vl-28b-a3b": {
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
		readonly "z-ai/glm-4.5v": {
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
		readonly "ai21/jamba-mini-1.7": {
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
		readonly "ai21/jamba-large-1.7": {
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
		readonly "openai/gpt-5": {
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
		readonly "openai/gpt-5-mini": {
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
		readonly "openai/gpt-5-nano": {
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
		readonly "openai/gpt-oss-120b:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-oss-120b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-oss-120b:exacto": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-oss-20b:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-oss-20b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "anthropic/claude-opus-4.1": {
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
		readonly "mistralai/codestral-2508": {
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
		readonly "qwen/qwen3-coder-30b-a3b-instruct": {
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
		readonly "qwen/qwen3-30b-a3b-instruct-2507": {
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
		readonly "z-ai/glm-4.5": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "z-ai/glm-4.5-air:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "z-ai/glm-4.5-air": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-235b-a22b-thinking-2507": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "z-ai/glm-4-32b": {
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
		readonly "qwen/qwen3-coder:free": {
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
		readonly "qwen/qwen3-coder": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-coder:exacto": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemini-2.5-flash-lite": {
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
		readonly "qwen/qwen3-235b-a22b-2507": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "moonshotai/kimi-k2": {
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
		readonly "mistralai/devstral-medium": {
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
		readonly "mistralai/devstral-small": {
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
		readonly "x-ai/grok-4": {
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
		readonly "tngtech/deepseek-r1t2-chimera": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "inception/mercury": {
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
		readonly "mistralai/mistral-small-3.2-24b-instruct": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "minimax/minimax-m1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemini-2.5-flash": {
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
		readonly "google/gemini-2.5-pro": {
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
		readonly "openai/o3-pro": {
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
		readonly "x-ai/grok-3-mini": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "x-ai/grok-3": {
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
		readonly "google/gemini-2.5-pro-preview": {
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
		readonly "deepseek/deepseek-r1-0528": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "anthropic/claude-opus-4": {
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
		readonly "anthropic/claude-sonnet-4": {
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
		readonly "nousresearch/deephermes-3-mistral-24b-preview": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/mistral-medium-3": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemini-2.5-pro-preview-05-06": {
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
		readonly "arcee-ai/virtuoso-large": {
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
		readonly "inception/mercury-coder": {
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
		readonly "qwen/qwen3-4b:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-30b-a3b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-8b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-14b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-32b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen3-235b-a22b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/o4-mini-high": {
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
		readonly "openai/o3": {
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
		readonly "openai/o4-mini": {
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
		readonly "openai/gpt-4.1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-4.1-mini": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-4.1-nano": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "x-ai/grok-3-mini-beta": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "x-ai/grok-3-beta": {
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
		readonly "meta-llama/llama-4-maverick": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "meta-llama/llama-4-scout": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepseek/deepseek-chat-v3-0324": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/mistral-small-3.1-24b-instruct:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/mistral-small-3.1-24b-instruct": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemma-3-27b-it:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemma-3-27b-it": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwq-32b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemini-2.0-flash-lite-001": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "anthropic/claude-3.7-sonnet:thinking": {
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
		readonly "anthropic/claude-3.7-sonnet": {
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
		readonly "mistralai/mistral-saba": {
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
		readonly "openai/o3-mini-high": {
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
		readonly "google/gemini-2.0-flash-001": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen-vl-max": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "qwen/qwen-turbo": {
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
		readonly "qwen/qwen-plus": {
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
		readonly "qwen/qwen-max": {
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
		readonly "openai/o3-mini": {
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
		readonly "mistralai/mistral-small-24b-instruct-2501": {
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
		readonly "deepseek/deepseek-r1-distill-llama-70b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepseek/deepseek-r1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "deepseek/deepseek-chat": {
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
		readonly "openai/o1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "google/gemini-2.0-flash-exp:free": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "meta-llama/llama-3.3-70b-instruct:free": {
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
		readonly "meta-llama/llama-3.3-70b-instruct": {
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
		readonly "amazon/nova-lite-v1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "amazon/nova-micro-v1": {
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
		readonly "amazon/nova-pro-v1": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-4o-2024-11-20": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/mistral-large-2411": {
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
		readonly "mistralai/mistral-large-2407": {
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
		readonly "mistralai/pixtral-large-2411": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "thedrummer/unslopnemo-12b": {
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
		readonly "anthropic/claude-3.5-haiku": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "anthropic/claude-3.5-sonnet": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/ministral-3b": {
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
		readonly "mistralai/ministral-8b": {
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
		readonly "qwen/qwen-2.5-7b-instruct": {
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
		readonly "nvidia/llama-3.1-nemotron-70b-instruct": {
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
		readonly "thedrummer/rocinante-12b": {
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
		readonly "qwen/qwen-2.5-72b-instruct": {
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
		readonly "mistralai/pixtral-12b": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "cohere/command-r-plus-08-2024": {
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
		readonly "cohere/command-r-08-2024": {
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
		readonly "sao10k/l3.1-euryale-70b": {
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
		readonly "openai/gpt-4o-2024-08-06": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "meta-llama/llama-3.1-70b-instruct": {
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
		readonly "meta-llama/llama-3.1-405b-instruct": {
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
		readonly "meta-llama/llama-3.1-8b-instruct": {
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
		readonly "mistralai/mistral-nemo": {
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
		readonly "openai/gpt-4o-mini": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-4o-mini-2024-07-18": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "sao10k/l3-euryale-70b": {
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
		readonly "openai/gpt-4o": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-4o:extended": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "openai/gpt-4o-2024-05-13": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "meta-llama/llama-3-8b-instruct": {
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
		readonly "mistralai/mixtral-8x22b-instruct": {
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
		readonly "openai/gpt-4-turbo": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "anthropic/claude-3-haiku": {
			id: string;
			name: string;
			api: "openai-completions";
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
		readonly "mistralai/mistral-large": {
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
		readonly "openai/gpt-3.5-turbo-0613": {
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
		readonly "openai/gpt-4-turbo-preview": {
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
		readonly "mistralai/mistral-tiny": {
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
		readonly "mistralai/mixtral-8x7b-instruct": {
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
		readonly "openai/gpt-4-1106-preview": {
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
		readonly "openai/gpt-3.5-turbo-16k": {
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
		readonly "openai/gpt-4-0314": {
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
		readonly "openai/gpt-4": {
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
		readonly "openai/gpt-3.5-turbo": {
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
	};
};
//# sourceMappingURL=models.generated.d.ts.map
