/**
 * AI Gateway transport over the Workers AI binding.
 *
 * pi's Cloudflare AI Gateway support speaks HTTPS
 * (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`, see `api/cloudflare.ts`),
 * which needs a Cloudflare API token even when the caller is a Worker in the gateway's own
 * account.
 *
 * A Worker avoids that token by talking to the gateway through the AI binding's `fetch`
 * passthrough (`env.AI.fetch()`), which serves the gateway's provider passthrough at
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/{endpoint...}` — the same
 * shape as the HTTPS URL, minus the account id (the binding channel carries identity). Binding
 * calls are pre-authenticated in-account and return the provider's native wire format as a
 * regular (streaming) `Response`, so API implementations behave identically over either
 * transport.
 *
 * A model whose `baseUrl` names that route therefore needs no translation: point it there and
 * pass {@link createAiBindingFetch} as the request `fetch`. Nothing is rewritten, buffered or
 * re-encoded — method, headers, query string and the body stream go to the binding as they
 * arrive, so every method, non-JSON body and streaming request body works.
 *
 * The only thing this module adds over calling `env.AI.fetch()` yourself is a type: `Ai#fetch`
 * exists at runtime (`workerd/src/cloudflare/internal/ai-api.ts:158`) but
 * `@cloudflare/workers-types`' `Ai` class does not declare it yet, so calling it directly means
 * casting the binding at every call site. {@link AiBinding} takes the cast instead — declare
 * `fetch` optional, check it once at construction — so `env.AI` can be passed as-is. Once
 * workers-types declares `fetch`, the optional marker and the runtime check both go away.
 */

import type { FetchFunction } from "../types.ts";

/**
 * The Workers AI binding (`env.AI`), described structurally so this module does not depend on
 * `@cloudflare/workers-types`.
 *
 * `fetch` is optional only because the published `Ai` type doesn't declare it yet — every real
 * binding has it at runtime. `aiGatewayLogId` is here to pin the type to the AI binding: it is
 * the one member unique to `Ai`, so without it this interface would also accept an `AiGateway`
 * or any hand-rolled `{ fetch }` object, which is exactly the mistake the runtime check reports
 * late.
 */
export interface AiBinding {
	aiGatewayLogId: string | null;
	fetch?(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Placeholder value for auth headers on binding-routed requests. API implementations
 * require an API key or a recognized auth header (`authorization`, `x-api-key`,
 * `cf-aig-authorization`) before dispatch; binding calls are pre-authenticated, so pass
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` to satisfy
 * the check. The gateway ignores (and strips) `cf-aig-authorization` on binding-routed
 * requests. Pair it with `Authorization: null` / `x-api-key: null` so the SDKs' placeholder
 * auth headers never reach the gateway, which would treat a request-supplied auth header as a
 * BYOK provider key that overrides its stored keys — the same as it would over HTTPS.
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

/**
 * Create a `fetch` backed by the AI binding, for models whose `baseUrl` already names a route
 * the binding serves — including the gateway's provider passthrough,
 * `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/...`. Requests pass
 * through untouched.
 *
 * ```ts
 * const model = {
 *   // ...
 *   baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${gateway}/anthropic`,
 * };
 * await models.complete(model, context, {
 *   headers: {
 *     "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
 *     Authorization: null,
 *     "x-api-key": null,
 *   },
 *   fetch: createAiBindingFetch(env.AI),
 * });
 * ```
 */
export function createAiBindingFetch(binding: AiBinding): FetchFunction {
	// `fetch` is optional on the type, so its presence is checked here — early, rather than as a
	// confusing failure on the first inference request.
	if (typeof binding.fetch !== "function") {
		throw new TypeError("createAiBindingFetch: the AI binding does not expose fetch()");
	}
	// Bound eagerly: `fetch` is a mutable property, so the narrowing above would not survive into
	// the returned closure.
	const bindingFetch = binding.fetch.bind(binding);
	return (input, init) => bindingFetch(input, init);
}
