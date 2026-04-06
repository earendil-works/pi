/**
 * Wait for a specified number of milliseconds, optionally with an abort signal.
 */
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * Parse a retry delay from a Gemini error message if present.
 * Example: "Your quota will reset after 45s."
 */
export declare function parseGeminiRetryAfter(message: string): number | undefined;
/**
 * Calculate exponential backoff with jitter.
 */
export declare function getExponentialBackoff(attempt: number, baseDelay: number, maxDelay: number): number;
//# sourceMappingURL=retry.d.ts.map