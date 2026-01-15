import type { RetryClass, StreamFunction } from "../types.js";
export declare class CodexHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs?: number;
	constructor(message: string, status: number, retryAfterMs?: number);
}
export declare function isRetryableCodexError(error: unknown, signal?: AbortSignal, retryOn?: RetryClass[]): boolean;
export declare function getRetryDelay(attempt: number, baseDelay: number, maxDelay: number, error: unknown): number;
export declare const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses">;
//# sourceMappingURL=openai-codex-responses.d.ts.map
