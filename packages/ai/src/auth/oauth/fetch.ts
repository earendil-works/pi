/**
 * The fetch that every OAuth flow sends its requests with.
 *
 * Browsers cannot reach some providers' auth endpoints because those endpoints send no CORS headers.
 * A runtime that routes such requests elsewhere, for example through a relay, replaces this fetch once
 * through `registerOAuthFlows`. Until then, flows use the global fetch, looked up on every call so that
 * tests and wrappers that replace `globalThis.fetch` keep working.
 */

/** How flows call fetch: always with a URL and an init, never with a `Request`. */
export type OAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

let replacement: OAuthFetch | undefined;

/** Replace the fetch of every OAuth flow, or restore the global fetch with `undefined`. */
export function setOAuthFetch(fetchImpl: OAuthFetch | undefined): void {
	replacement = fetchImpl;
}

/** Send one OAuth flow request. */
export function oauthFetch(input: string | URL, init?: RequestInit): Promise<Response> {
	return replacement ? replacement(input, init) : fetch(input, init);
}
