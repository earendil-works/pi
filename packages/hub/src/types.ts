export interface Profile {
	provider?: string;
	model?: string;
	models?: string[];
	thinking?: string;
	token?: string;
	url?: string;
	/** Arbitrary settings.json overrides, merged over the source agent settings.
	 *  A null value deletes the key from the materialized settings.json. */
	settings?: Record<string, unknown>;
}

export interface ProfilesData {
	profiles: Record<string, Profile>;
	default?: string;
}

export interface AgentSettingsData {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	skills?: unknown;
	[key: string]: unknown;
}

export interface AuthEntry {
	type: string;
	key?: string;
	[key: string]: unknown;
}

export interface AuthData {
	[provider: string]: AuthEntry | undefined;
}

export interface ModelsFileData {
	providers: Record<string, { baseUrl?: string; [key: string]: unknown }>;
}

// Known pi provider ids (from pi-coding-agent docs/providers.md). Warn-only:
// unknown ids are allowed because pi supports custom providers via models.json.
export const PI_PROVIDERS: string[] = [
	"anthropic",
	"ant-ling",
	"azure-openai-responses",
	"openai",
	"deepseek",
	"nvidia",
	"google",
	"amazon-bedrock",
	"mistral",
	"groq",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"xai",
	"openrouter",
	"vercel-ai-gateway",
	"zai",
	"zai-coding-cn",
	"opencode",
	"opencode-go",
	"radius",
	"huggingface",
	"fireworks",
	"together",
	"baseten",
	"kimi-coding",
	"minimax",
	"minimax-cn",
	"qwen-token-plan",
	"qwen-token-plan-intl",
	"qwen-token-plan-individual",
	"qwen-token-plan-cn",
	"xiaomi",
	"xiaomi-cn",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
	"moonshotai",
	"moonshotai-cn",
];

export const THINKING_LEVELS: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Marker stored in `profiles.json` `default` meaning "no profile, run plain pi". */
export const BUILT_IN_DEFAULT = "__builtin__";
