import type { AuthInteraction, AuthPrompt, AuthType, Provider } from "@earendil-works/pi-ai";
import { replaceControlCharacters } from "@earendil-works/pi-tui";
import { APP_NAME, getAuthPath } from "../config.ts";
import { CredentialSynchronizationError, type ModelRuntime } from "../core/model-runtime.ts";
import { findMatchingProviders } from "../core/provider-matching.ts";
import { RADIUS_PROVIDER_ID } from "../core/radius.ts";
import { planRadiusMcpServer } from "../core/radius-mcp.ts";
import { addMcpServerConfig } from "../extensions/mcp/config.ts";
import { displayUrl, webUrl } from "../utils/web-url.ts";

import type { LoginTerminal } from "./auth-terminal.ts";

/** Dependencies of `runAuthLogin`, injected so tests can script the terminal. */
export interface AuthLoginOptions {
	modelRuntime: ModelRuntime;
	terminal: LoginTerminal;
	agentDir: string;
	cwd: string;
	getDeviceId: () => string;
	/** Aborts the login, e.g. on Ctrl+C. */
	signal: AbortSignal;
}

const AUTH_LOGIN_USAGE = `${APP_NAME} auth login <provider> [--api-key] [--no-browser]`;

/** Parsed `pi auth login` arguments. */
interface LoginRequest {
	providerRef: string;
	/** Log in with an API key instead of an account. */
	apiKey: boolean;
	/** Open the browser and take the browser sign-in method without asking. */
	browser: boolean;
}

/** Run `pi auth login <provider>` in the terminal and return the process exit code. */
export async function runAuthLogin(args: string[], options: AuthLoginOptions): Promise<number> {
	const { modelRuntime, terminal, signal } = options;
	const parsed = parseLoginRequest(args);
	if (parsed.type === "invalid") {
		terminal.error(parsed.message);
		return 1;
	}
	const { request } = parsed;
	const { providerRef } = request;

	const provider = findMatchingProviders(modelRuntime.getProviders(), providerRef)[0];
	if (!provider) {
		const loginProviders = modelRuntime
			.getProviders()
			.filter((candidate) => candidate.auth.oauth || candidate.auth.apiKey?.login)
			.map((candidate) => candidate.id)
			.sort();
		terminal.error(`Unknown provider "${replaceControlCharacters(providerRef)}".`);
		terminal.error(`Providers: ${loginProviders.join(", ")}`);
		return 1;
	}
	if (!terminal.interactive) {
		terminal.error(`"${AUTH_LOGIN_USAGE}" requires an interactive terminal`);
		return 1;
	}

	const authType = selectAuthType(provider, request.apiKey);
	if (authType.type === "unavailable") {
		terminal.error(authType.message);
		return 1;
	}
	try {
		await modelRuntime.login(
			provider.id,
			authType.type,
			createLoginInteraction(provider.id, authType.type, request, terminal, signal),
			{ getDeviceId: options.getDeviceId },
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof CredentialSynchronizationError) {
			terminal.error(`Logged in to ${provider.name}, but local model state could not be synchronized: ${message}`);
		} else if (signal.aborted || message === "Login cancelled") {
			terminal.error("Login cancelled.");
		} else {
			terminal.error(`Failed to log in to ${provider.name}: ${message}`);
		}
		return 1;
	}

	terminal.write(
		`${authType.type === "oauth" ? `Logged in to ${provider.name}` : `Saved API key for ${provider.name}`}. Credentials saved to ${getAuthPath()}`,
	);
	await refreshProviderCatalog(provider, modelRuntime, terminal, signal);
	if (provider.id === RADIUS_PROVIDER_ID) configureRadiusMcpServer(provider, options);
	return 0;
}

function parseLoginRequest(
	args: string[],
): { type: "valid"; request: LoginRequest } | { type: "invalid"; message: string } {
	const usage = { type: "invalid", message: `Usage: ${AUTH_LOGIN_USAGE}` } as const;
	const request: LoginRequest = { providerRef: "", apiKey: false, browser: true };
	for (const arg of args) {
		if (arg === "--api-key") request.apiKey = true;
		else if (arg === "--no-browser") request.browser = false;
		else if (arg.startsWith("-") || request.providerRef) return usage;
		else request.providerRef = arg;
	}
	if (!request.providerRef) return usage;
	if (request.apiKey && !request.browser) {
		return { type: "invalid", message: "--no-browser only applies to account sign-in; omit it with --api-key." };
	}
	return { type: "valid", request };
}

/**
 * Account login unless `apiKey` asks for an API key. Providers without account login use their API key login, since
 * that is the only way in.
 */
function selectAuthType(
	provider: Provider,
	apiKey: boolean,
): { type: AuthType } | { type: "unavailable"; message: string } {
	const hasApiKeyLogin = provider.auth.apiKey?.login !== undefined;
	if (!apiKey && provider.auth.oauth) return { type: "oauth" };
	if (hasApiKeyLogin) return { type: "api_key" };
	if (apiKey && provider.auth.oauth) {
		return { type: "unavailable", message: `${provider.name} has no API key login. Omit --api-key to sign in.` };
	}
	const method = provider.auth.apiKey?.name ?? "ambient credentials";
	return { type: "unavailable", message: `${provider.name} is configured outside ${APP_NAME} (${method}).` };
}

/** Adapt provider prompts and events to the command's selected sign-in method. */
function createLoginInteraction(
	providerId: string,
	authType: AuthType,
	request: LoginRequest,
	terminal: LoginTerminal,
	signal: AbortSignal,
): AuthInteraction {
	// Account logins list the browser sign-in first, as /login; API key setup asks every selection.
	const methodChoice = authType === "api_key" ? "ask" : request.browser ? "browser" : "other";
	let skippedMethods: string[] = [];

	async function selectMethod(prompt: Extract<AuthPrompt, { type: "select" }>, promptSignal: AbortSignal) {
		const [first, ...others] = prompt.options;
		if (methodChoice === "ask" || !first) {
			return selectInTerminal(prompt.message, prompt.options, terminal, promptSignal);
		}
		if (methodChoice === "browser") {
			skippedMethods = others.map((option) => option.label);
			return first.id;
		}
		const [onlyOther, ...moreOthers] = others;
		// A provider whose only method is the browser sign-in still gets it, without opening the browser.
		if (!onlyOther) return first.id;
		if (moreOthers.length > 0) return selectInTerminal(prompt.message, others, terminal, promptSignal);
		terminal.write(`${prompt.message} ${onlyOther.label}`);
		return onlyOther.id;
	}

	return {
		signal,
		prompt(prompt) {
			// The browser callback can finish a step before the pasted code, cancelling just that prompt.
			const promptSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
			if (prompt.type === "select") return selectMethod(prompt, promptSignal);
			const placeholder = prompt.placeholder ? ` (${prompt.placeholder})` : "";
			const message = `${prompt.message}${placeholder}: `;
			return prompt.type === "secret"
				? terminal.secret(message, promptSignal)
				: terminal.question(message, promptSignal);
		},
		notify(event) {
			if (event.type === "auth_url") {
				terminal.write(`Open this URL to sign in:\n  ${displayUrl(event.url)}`);
				if (event.instructions) terminal.write(event.instructions);
				const target = webUrl(event.url);
				if (target !== undefined && request.browser) terminal.openUrl(target);
				// Providers without a method choice have nothing else to offer, so they get no hint.
				const rerun = `"${APP_NAME} auth login ${providerId} --no-browser"`;
				const [onlyMethod, ...moreMethods] = skippedMethods;
				if (onlyMethod !== undefined && moreMethods.length === 0) {
					terminal.write(`To use "${onlyMethod}" instead, run ${rerun}`);
				} else if (onlyMethod !== undefined) {
					const labels = skippedMethods.map((label) => `"${label}"`).join(", ");
					terminal.write(`Other sign-in methods: ${labels}. Run ${rerun} to choose one.`);
				}
			} else if (event.type === "device_code") {
				terminal.write(`Open ${displayUrl(event.verificationUri)} and enter code: ${event.userCode}`);
				const target = webUrl(event.verificationUri);
				if (target !== undefined && request.browser && event.openBrowserOnConfirm !== false) {
					terminal.openUrl(target);
				}
				terminal.write("Waiting for authentication...");
			} else if (event.type === "info") {
				terminal.write(event.message);
				for (const link of event.links ?? []) {
					terminal.write(`  ${link.label ? `${link.label}: ` : ""}${displayUrl(link.url)}`);
				}
			} else {
				terminal.write(event.message);
			}
		},
	};
}

async function selectInTerminal(
	message: string,
	options: readonly { id: string; label: string; description?: string }[],
	terminal: LoginTerminal,
	signal: AbortSignal,
): Promise<string> {
	terminal.write(message);
	options.forEach((option, index) => {
		terminal.write(`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`);
	});
	while (true) {
		const answer = (await terminal.question(`Select 1-${options.length}: `, signal)).trim();
		const option = /^\d+$/u.test(answer) ? options[Number(answer) - 1] : undefined;
		if (option) return option.id;
		terminal.write(`Enter a number from 1 to ${options.length}.`);
	}
}

/** Fetch the provider's model catalog now, since dynamic catalogs stay empty until the first authenticated refresh. */
async function refreshProviderCatalog(
	provider: Provider,
	modelRuntime: ModelRuntime,
	terminal: LoginTerminal,
	signal: AbortSignal,
) {
	// The login is saved by now, so Ctrl+C only skips the refresh.
	const cancelled = () => {
		terminal.write(`Skipped the ${provider.name} model catalog refresh; ${APP_NAME} refreshes it on next start.`);
	};
	try {
		const result = await modelRuntime.refresh({
			providers: [provider.id],
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (signal.aborted) {
			cancelled();
		} else if (result.aborted) {
			terminal.write(
				`The ${provider.name} model catalog refresh timed out; ${APP_NAME} refreshes it on next start.`,
			);
		} else if (result.errors.size > 0) {
			terminal.write(
				`The ${provider.name} model catalog could not be refreshed; ${APP_NAME} retries on next start.`,
			);
		}
	} catch (error: unknown) {
		if (signal.aborted) {
			cancelled();
			return;
		}
		terminal.write(
			`The ${provider.name} model catalog could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Point the Radius MCP server in the global mcp.json at the Radius login without asking, since the login is what the
 * server needs; /login asks instead. Nothing changes when a global server already uses this login.
 */
function configureRadiusMcpServer(provider: Provider, options: AuthLoginOptions): void {
	const { terminal } = options;
	const plan = planRadiusMcpServer(provider.id, options.agentDir, options.cwd);
	if (!plan) return;
	try {
		const replaced = addMcpServerConfig(plan.mcpPath, plan.name, plan.config);
		terminal.write(
			`${replaced ? "Updated" : "Added"} MCP server "${plan.name}" in ${plan.mcpPath} to use the ${provider.name} login.`,
		);
	} catch (error: unknown) {
		terminal.error(`Could not update ${plan.mcpPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
