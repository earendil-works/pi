import type { FetchLike } from "./owner.ts";

/** `fetch` with a 10-second timeout, in the shape the sign-in code uses. */
export const realFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
