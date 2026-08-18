import type { AuthResult } from "@earendil-works/pi-ai";
import { t } from "@earendil-works/pi-tui";
import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key" | "bearer_token";

export interface AuthCommand {
	kind: AuthCommandKind;
	args: string[];
	json: boolean;
	credentials: boolean;
	noRefresh: boolean;
	minExpiryMs?: number;
}

export class AuthCommandError extends Error {}

function getAuthCommandUsageText(kind: AuthCommandKind): string {
	switch (kind) {
		case "check":
			return t("codingAgent.cli.authHelp.authCheck");
		case "api_key":
			return t("codingAgent.cli.authHelp.printApiKey");
		case "bearer_token":
			return t("codingAgent.cli.authHelp.printBearerToken");
	}
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return getAuthCommandUsageText(kind);
}

export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check" ? "auth check" : kind === "api_key" ? "auth print-api-key" : "auth print-bearer-token";
}

export function isAuthCommandHelp(args: string[]): boolean {
	return (
		args[0] === "auth" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printAuthCommandHelp(): void {
	console.log(`${t("codingAgent.cli.authHelp.usage")}
${t("codingAgent.cli.authHelp.printApiKey")}
${t("codingAgent.cli.authHelp.printBearerToken")}
${t("codingAgent.cli.authHelp.authCheck")}
${t("codingAgent.cli.authHelp.description")}`);
}

export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind =
		args[1] === "check"
			? "check"
			: args[1] === "print-api-key"
				? "api_key"
				: args[1] === "print-bearer-token"
					? "bearer_token"
					: undefined;
	if (!kind) {
		throw new AuthCommandError(
			t("codingAgent.errors.auth.unknownAuthCommand", { command: args[1] ?? "", appName: APP_NAME }),
		);
	}

	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--min-expiry") {
			if (kind !== "bearer_token") throw new AuthCommandError(t("codingAgent.errors.auth.minExpiryOnlyBearer"));
			const value = args[++index];
			const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
			if (!match) throw new AuthCommandError(t("codingAgent.errors.auth.minExpiryInvalidDuration"));
			const amount = Number(match[1]);
			const unit = match[2];
			minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
			continue;
		}
		if (arg === "--json" || arg === "--credentials" || arg === "--no-refresh") {
			if (kind !== "check") throw new AuthCommandError(t("codingAgent.errors.auth.flagOnlyForCheck", { flag: arg }));
			if (arg === "--json") json = true;
			else if (arg === "--credentials") credentials = true;
			else noRefresh = true;
			continue;
		}
		commandArgs.push(arg);
	}

	return minExpiryMs === undefined
		? { kind, args: commandArgs, json, credentials, noRefresh }
		: { kind, args: commandArgs, json, credentials, noRefresh, minExpiryMs };
}

export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value ?? "";
		throw new AuthCommandError(
			t("codingAgent.errors.auth.unknownAuthOption", { option, command: getAuthCommandName(kind) }),
		);
	}
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError(t("codingAgent.errors.auth.authOnlyProviderModel"));
	}
	if (kind === "check") {
		if (!provider && !model) {
			throw new AuthCommandError(t("codingAgent.errors.auth.authCheckRequiresProvider"));
		}
		return { provider, model };
	}
	if (!provider && !model) {
		throw new AuthCommandError(t("codingAgent.errors.auth.credentialPrintRequiresProvider"));
	}
	return { provider, model };
}

export function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
