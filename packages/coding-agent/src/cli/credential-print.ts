import type { Api, CredentialInfo, Model } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";

export type CredentialPrintKind = "api_key" | "bearer_token";

const DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS = 30 * 60_000;

export interface CredentialPrintCommand {
	kind: CredentialPrintKind;
	args: string[];
	minExpiryMs?: number;
}

export class CredentialPrintError extends Error {}

export function isCredentialPrintHelp(args: string[]): boolean {
	return (
		args[0] === "auth" && (args[1] === undefined || args[1] === "help" || args[1] === "--help" || args[1] === "-h")
	);
}

export function printCredentialPrintHelp(): void {
	console.log(`Usage:
  pi auth print-api-key --model <model> [--provider <provider>]
  pi auth print-bearer-token --model <model> [--provider <provider>] [--min-expiry <duration>]

Prints the configured credential alone on stdout. Provider inference uses configured credentials; specify --provider to select explicitly. Bearer tokens have a 30-minute minimum expiry by default. --min-expiry accepts ms, s, m, or h (for example, 30m).`);
}

/** Parse the small, extensible `pi auth` command surface before normal startup. */
export function parseCredentialPrintCommand(args: string[]): CredentialPrintCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind = args[1] === "print-api-key" ? "api_key" : args[1] === "print-bearer-token" ? "bearer_token" : undefined;
	if (!kind) {
		throw new CredentialPrintError(
			`Unknown auth command "${args[1] ?? ""}". Use "pi auth print-api-key" or "pi auth print-bearer-token".`,
		);
	}

	const commandArgs: string[] = [];
	let minExpiryMs: number | undefined;
	for (let index = 2; index < args.length; index++) {
		if (args[index] !== "--min-expiry") {
			commandArgs.push(args[index]);
			continue;
		}
		if (kind !== "bearer_token") {
			throw new CredentialPrintError("--min-expiry is only supported by print-bearer-token");
		}
		const value = args[++index];
		const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
		if (!match) {
			throw new CredentialPrintError("--min-expiry must use a duration such as 30m or 1h");
		}
		const amount = Number(match[1]);
		const unit = match[2];
		minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
	}

	return minExpiryMs === undefined ? { kind, args: commandArgs } : { kind, args: commandArgs, minExpiryMs };
}

export function validateCredentialPrintArgs(args: Args): void {
	if (!args.model?.trim()) {
		throw new CredentialPrintError("Credential printing requires --model <model>");
	}
	if (args.apiKey !== undefined) {
		throw new CredentialPrintError("Credential printing reads configured credentials; --api-key is not supported");
	}
	if (args.messages.length > 0 || args.fileArgs.length > 0 || args.unknownFlags.size > 0) {
		throw new CredentialPrintError("Credential printing only accepts --provider and --model");
	}
}

/**
 * Resolve one request credential for a specific provider/model pair.
 *
 * This intentionally calls ModelRuntime.getAuth(), which refreshes and persists
 * OAuth credentials with less than five minutes remaining through the normal request-auth path.
 */
export async function resolveCredentialForPrint(
	args: Args,
	modelRuntime: ModelRuntime,
	kind: CredentialPrintKind,
	minExpiryMs?: number,
): Promise<string> {
	validateCredentialPrintArgs(args);

	const credentialTypes = new Map<string, CredentialInfo["type"]>(
		(await modelRuntime.listCredentials()).map((credential) => [credential.providerId, credential.type]),
	);
	const models: Model<Api>[] = [];
	if (args.provider) {
		const resolved = resolveCliModel({ cliProvider: args.provider, cliModel: args.model, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new CredentialPrintError(resolved.error ?? "Unable to resolve the requested provider/model");
		}
		models.push(resolved.model);
	} else {
		for (const provider of modelRuntime.getProviders()) {
			if (!credentialTypes.has(provider.id)) continue;
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: args.model, modelRuntime });
			if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
				models.push(resolved.model);
			}
		}
		if (models.length === 0) {
			throw new CredentialPrintError(`Model "${args.model}" not found. Use --list-models to see available models.`);
		}
	}

	const credentials: Array<{ providerId: string; value: string }> = [];
	for (const model of models) {
		const type = credentialTypes.get(model.provider);
		if (kind === "api_key" && type === "oauth") continue;
		if (kind === "bearer_token" && type !== "oauth") continue;

		const auth = await modelRuntime.getAuth(
			model,
			kind === "bearer_token"
				? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS }
				: undefined,
		);
		const authorization = Object.entries(auth?.auth.headers ?? {}).find(
			([name]) => name.toLowerCase() === "authorization",
		)?.[1];
		const bearerToken = typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
		const value = kind === "bearer_token" ? (auth?.auth.apiKey ?? bearerToken) : auth?.auth.apiKey;
		if (value) credentials.push({ providerId: model.provider, value });
	}

	if (credentials.length === 1) return credentials[0].value;
	if (credentials.length === 0) {
		const providerId = models[0]?.provider;
		const type = providerId ? credentialTypes.get(providerId) : undefined;
		if (args.provider && kind === "api_key" && type === "oauth") {
			throw new CredentialPrintError(`Provider "${providerId}" is configured with OAuth, not an API key`);
		}
		if (args.provider && kind === "bearer_token" && type !== "oauth") {
			throw new CredentialPrintError(`Provider "${providerId}" is not configured with an OAuth bearer token`);
		}
		throw new CredentialPrintError(
			`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`,
		);
	}
	throw new CredentialPrintError(
		`Model "${args.model}" has multiple configured providers (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`,
	);
}
