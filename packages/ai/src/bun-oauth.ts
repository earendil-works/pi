import { registerOAuthFlows } from "./oauth-flows.ts";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
export function registerBunOAuthFlows(): void {
	registerOAuthFlows();
}
