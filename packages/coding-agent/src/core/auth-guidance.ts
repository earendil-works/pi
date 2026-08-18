import { t } from "@earendil-works/pi-tui";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return t("codingAgent.errors.auth.loginHelp", { docsPath: getDocsPath() });
}

export function formatNoModelsAvailableMessage(): string {
	return t("codingAgent.errors.auth.noModels", { loginHelp: getProviderLoginHelp() });
}

export function formatNoModelSelectedMessage(): string {
	return t("codingAgent.errors.auth.noModelSelected", { loginHelp: getProviderLoginHelp() });
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return t("codingAgent.errors.auth.noApiKeyForProvider", {
		provider: providerDisplay,
		loginHelp: getProviderLoginHelp(),
	});
}
