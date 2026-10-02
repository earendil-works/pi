/**
 * pi-plus override for core/auth-guidance.ts: the TUI /login flow is disabled
 * (see ../modes/interactive/interactive-mode.ts), so every message that tells
 * the user to "use /login" must instead point at the profile login flow —
 * `pipi profile add <name> -p <provider>` runs the provider's OAuth/API-key
 * login into the profile's agent dir, and `-t <key>` stores a plain token.
 *
 * All four exports are re-implemented here (not just `getProviderLoginHelp`):
 * the upstream formatters call it inside their own module scope, so shadowing
 * the export alone would leave their strings unchanged.
 */

import { join } from "node:path";
import { getDocsPath } from "../../../../coding-agent/src/config.ts";

export * from "../../../../coding-agent/src/core/auth-guidance.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		"Log in with 'pipi profile add <name> -p <provider>' (OAuth login page or API-key setup),",
		"or store an API key with 'pipi profile update <name> -t <key>'. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
