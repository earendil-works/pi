import type { RetryClass, StreamFunction } from "../types.js";
/**
 * Sanitize tool call ID to meet OpenAI Codex requirements:
 * - Max 64 characters
 * - Must start with "fc_" for item IDs
 * - Only alphanumeric, underscore, hyphen allowed
 * - No trailing underscores
 */
export declare function sanitizeToolCallId(id: string): {
    callId: string;
    itemId: string;
};
export declare class CodexHttpError extends Error {
    readonly status: number;
    readonly retryAfterMs?: number;
    constructor(message: string, status: number, retryAfterMs?: number);
}
export declare function isRetryableCodexError(error: unknown, signal?: AbortSignal, retryOn?: RetryClass[]): boolean;
export declare function getRetryDelay(attempt: number, baseDelay: number, maxDelay: number, error: unknown): number;
export declare const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses">;
//# sourceMappingURL=openai-codex-responses.d.ts.map