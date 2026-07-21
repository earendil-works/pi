/**
 * Provider SDK retry policy for OpenAI/Anthropic clients.
 *
 * Those SDKs honor `Retry-After` without a delay cap and sleep with a plain
 * `setTimeout` that ignores AbortSignal. When a provider returns a multi-hour
 * or multi-day `Retry-After` (for example OpenCode `GoUsageLimitError` with
 * `retry-after: ~3 days`), the agent stays in "working" until that sleep ends
 * and Escape cannot interrupt it.
 *
 * Always pass this value as the SDK `maxRetries` option. Pi's agent-level
 * retry remains abortable and treats terminal usage/quota/billing errors as
 * non-retryable via {@link isRetryableAssistantError}.
 */
export const PROVIDER_SDK_MAX_RETRIES = 0 as const;
