// Redirect table for the pi-plus-sdk bundle (build.mjs): the shared core table
// (packages/plus/loader/redirects.mjs) plus the main.ts -> main-stub entry.
//
// Deliberately omits the CLI-only redirects (cli/args.ts, settings-selector), so the
// SDK ships upstream pi's argument parsing and settings selector — no pipi help text
// or CLI branding leaks into the library surface. The main.ts stub keeps the
// upstream CLI entry graph (startup UI, session picker, …) out of api.js entirely.
import { REDIRECTS as CORE_REDIRECTS } from "../../plus/loader/redirects.mjs";

export const REDIRECTS = new Map([
	...CORE_REDIRECTS,
	["packages/coding-agent/src/main.ts", "packages/plus-api/src/coding-agent/main-stub.ts"],
]);
