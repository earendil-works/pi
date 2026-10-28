// Modules that only exist when cloudflare.ts is built by Wrangler. Consumers get the real
// declarations from @cloudflare/workers-types or `wrangler types`; these keep this repository's
// type check free of a Workers type dependency and are not published.

declare module "cloudflare:workers" {
	export abstract class DurableObject<Env = unknown> {
		protected ctx: unknown;
		protected env: Env;
		constructor(ctx: unknown, env: Env);
	}
}

// A pattern, not the exact specifier: coding-agent declares "quickjs-wasi/quickjs.wasm" as a path
// for Bun, and an exact declaration takes precedence where both are visible. cloudflare.ts casts the
// import to the compiled module Wrangler actually produces.
declare module "*/quickjs.wasm" {
	const module: unknown;
	export default module;
}
