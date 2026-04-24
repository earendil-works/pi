import type { AuthCredential, AuthStatus } from "../../../core/auth-storage.js";

export type SelectorAuthType = "oauth" | "api_key";

export type AuthSelectorIndicator =
	| { kind: "configured"; label: string }
	| { kind: "configured-other"; label: string }
	| { kind: "runtime" }
	| { kind: "environment"; label: string }
	| { kind: "fallback" }
	| { kind: "unconfigured" };

function getConfiguredLabel(authType: SelectorAuthType): string {
	return authType === "oauth" ? "subscription configured" : "api key configured";
}

export function getAuthSelectorIndicator(
	authType: SelectorAuthType,
	credential: AuthCredential | undefined,
	authStatus?: AuthStatus,
): AuthSelectorIndicator {
	if (credential) {
		const label = getConfiguredLabel(credential.type);
		return credential.type === authType ? { kind: "configured", label } : { kind: "configured-other", label };
	}

	if (authType === "oauth") {
		return { kind: "unconfigured" };
	}

	if (authStatus?.source === "runtime") {
		return { kind: "runtime" };
	}

	if (authStatus?.source === "environment") {
		return { kind: "environment", label: authStatus.label ?? "API key" };
	}

	if (authStatus?.source === "fallback") {
		return { kind: "fallback" };
	}

	return { kind: "unconfigured" };
}
