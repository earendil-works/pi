/**
 * Response handling for Codex SSE streams.
 */
export type CodexRateLimit = {
	used_percent?: number;
	window_minutes?: number;
	resets_at?: number;
};
export type CodexRateLimits = {
	primary?: CodexRateLimit;
	secondary?: CodexRateLimit;
};
export type CodexErrorInfo = {
	message: string;
	status: number;
	friendlyMessage?: string;
	rateLimits?: CodexRateLimits;
	raw?: string;
};
export declare function parseCodexRateLimits(headers: Headers): CodexRateLimits | undefined;
export declare function parseCodexError(response: Response): Promise<CodexErrorInfo>;
/**
 * Parse SSE stream from Codex response.
 */
export declare function parseCodexSseStream(response: Response): AsyncGenerator<Record<string, unknown>>;
//# sourceMappingURL=response-handler.d.ts.map
