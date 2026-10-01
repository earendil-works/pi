/**
 * Redirect target for the `packages/coding-agent/src/main.ts` redirect in the
 * pi-plus-sdk bundle ONLY (see build/redirects.mjs). Never imported directly by
 * TypeScript sources — the redirect lands here at esbuild time.
 *
 * The upstream index barrel re-exports `main`, the CLI entry point. Shipping the
 * real one in api.js would drag the entire upstream CLI/TUI startup graph
 * (startup UI, session picker, auth command, package-manager CLI, …) into the SDK
 * bundle, and a host calling it would silently run upstream pi without the pi-plus
 * layer. The type-only MainOptions import below is erased at bundle time, so
 * upstream main.ts never enters the graph. Types for `main` still come from
 * `@earendil-works/pi-coding-agent` via api.d.ts; calling it is a documented error.
 */
import type { MainOptions } from "../../../coding-agent/src/main.ts";

export type { MainOptions };

export function main(_args: string[], _options?: MainOptions): Promise<never> {
	return Promise.reject(
		new Error(
			"pi-plus-sdk is a library artifact: the `pipi` CLI entry is not available here. Use createPlusAgentSession() instead.",
		),
	);
}
