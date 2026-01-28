import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	KnownProvider,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
} from "./types.js";
export declare function setApiKey(provider: KnownProvider, key: string): void;
export declare function setApiKey(provider: string, key: string): void;
/**
 * Get API key from environment variables (sync).
 * Does NOT check OAuth credentials - use resolveApiKey() for OAuth support.
 */
export declare function getApiKey(provider: KnownProvider): string | undefined;
export declare function getApiKey(provider: string): string | undefined;
export declare function getEnvApiKey(provider: KnownProvider): string | undefined;
export declare function getEnvApiKey(provider: string): string | undefined;
/**
 * Resolve API key from OAuth credentials or environment (async).
 * Automatically refreshes expired OAuth tokens.
 *
 * Priority:
 * 1. Explicitly set keys (via setApiKey)
 * 2. OAuth credentials from ~/.mu/agent/oauth.json
 * 3. Environment variables
 */
export declare function resolveApiKey(provider: KnownProvider): Promise<string | undefined>;
export declare function resolveApiKey(provider: string): Promise<string | undefined>;
export declare function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream;
export declare function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage>;
export declare function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream;
export declare function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage>;
//# sourceMappingURL=stream.d.ts.map
