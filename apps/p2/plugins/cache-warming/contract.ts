// The worker's cache warmer (host-internal): pi's prompt cache warming for every conversation of the session.
import { local } from "@p2/app/v1";

/**
 * Keeps the prompt cache entries of the session's conversations warm (`./warmer.ts`): one per worker, started with
 * it; a reload or a stop closes its timers and in-flight refreshes, and the next real request starts warming again.
 */
export const CacheWarmingRuntime = local("p2.cache-warming-runtime", { version: 1, params: {}, members: {} });
