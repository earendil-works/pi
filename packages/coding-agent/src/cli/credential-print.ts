import type { Api, CredentialInfo, Model } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, type AuthCommandKind, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

const DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS = 30 * 60_000;

type CredentialPrintKind = Exclude<AuthCommandKind, "check">;

/**
 * Resolve one configured provider credential.
 *
 * This intentionally calls ModelRuntime.getAuth(), which refreshes and persists
 * OAuth credentials with less than five minutes remaining through the normal request-auth path.
 */
export async function resolveCredentialForPrint(
	args: Args,
	modelRuntime: ModelRuntime,
	kind: CredentialPrintKind,
	minExpiryMs?: number,
	signal?: AbortSignal,
): Promise<string> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, kind);
	const credentialTypes = new Map<string, CredentialInfo["type"]>(
		(await modelRuntime.listCredentials({ signal })).map((credential) => [credential.providerId, credential.type]),
	);
	const providers: Array<{ id: string; model?: Model<Api> }> = [];
	if (cliProvider) {
		const provider = modelRuntime.getProvider(cliProvider);
		if (!provider) {
			throw new AuthCommandError(`Unknown provider "${cliProvider}". Use --list-models to see available providers.`);
		}
		if (cliModel) {
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel, modelRuntime });
			if (resolved.error || !resolved.model) {
				throw new AuthCommandError(resolved.error ?? "Unable to resolve the requested provider/model");
			}
			providers.push({ id: provider.id, model: resolved.model });
		} else {
			providers.push({ id: provider.id });
		}
	} else {
		for (const provider of modelRuntime.getProviders()) {
			if (!credentialTypes.has(provider.id)) continue;
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: cliModel!, modelRuntime });
			if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
				providers.push({ id: provider.id, model: resolved.model });
			}
		}
		if (providers.length === 0) {
			throw new AuthCommandError(`Model "${cliModel}" not found. Use --list-models to see available models.`);
		}
	}

	const credentials: Array<{ providerId: string; value: string }> = [];
	for (const provider of providers) {
		const type = credentialTypes.get(provider.id);
		if (kind === "api_key" && type === "oauth") continue;
		if (kind === "bearer_token" && type !== "oauth") continue;
		const authOptions = {
			...(kind === "bearer_token" ? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS } : {}),
			signal,
		};
		const auth = provider.model
			? await modelRuntime.getAuth(provider.model, authOptions)
			: await modelRuntime.getAuth(provider.id, authOptions);
		const value = getAuthCredential(auth);
		if (value) credentials.push({ providerId: provider.id, value });
	}

	if (credentials.length === 1) return credentials[0].value;
	if (credentials.length === 0) {
		const providerId = providers[0]?.id;
		const type = providerId ? credentialTypes.get(providerId) : undefined;
		if (cliProvider && kind === "api_key" && type === "oauth") {
			throw new AuthCommandError(`Provider "${providerId}" is configured with OAuth, not an API key`);
		}
		if (cliProvider && kind === "bearer_token" && type !== "oauth") {
			throw new AuthCommandError(`Provider "${providerId}" is not configured with an OAuth bearer token`);
		}
		throw new AuthCommandError(`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`);
	}
	throw new AuthCommandError(
		`Multiple configured providers matched (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`,
	);
}
