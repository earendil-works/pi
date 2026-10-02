/**
 * Provider login for SDK hosts: a curated re-export of the pi-plus shared
 * core login entry (packages/plus/src/auth/login.ts). `loginProvider` runs a
 * provider's interactive login — OAuth (opens the provider's login page) when
 * the provider offers it, else API-key setup — and persists the credential to
 * <agentDir>/auth.json, the same store pi reads at launch. Hosts pass their
 * own `interaction` to drive the prompts from their UI, or omit it for the
 * terminal default; combined with the profile surface in ./profiles.ts this
 * reproduces `pipi profile add <name> -p <provider>` (materializeProfile gives
 * the profile dir, loginProvider writes the credential into it). pi's TUI
 * /login is disabled in pi-plus (see packages/plus/loader/redirects.mjs), so
 * this is the login path for both CLI and embedded hosts.
 */

export type {
	AuthEvent,
	AuthInfoLink,
	AuthInteraction,
	AuthPrompt,
	AuthType,
	Credential,
	LoginProviderOptions,
} from "../../plus/src/auth/login.ts";
export { createTerminalAuthInteraction, loginProvider } from "../../plus/src/auth/login.ts";
