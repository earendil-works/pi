import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import type { AuthEvent, AuthPrompt, AuthResult } from "@earendil-works/pi-ai";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { openBrowser } from "../utils/open-browser.ts";

export class AuthContinueError extends Error {}

type JsonObject = Record<string, unknown>;

interface AuthContinuationBase {
	version: 1;
	serviceUrl: string;
	providerId: string;
	continuationId: string;
	secret: string;
	returnUrl: string;
}

interface McpContinuationBase {
	serverUrl: string;
	serverName: string;
}

export type AuthContinuationPayload = AuthContinuationBase &
	(
		| { mcp: McpContinuationBase & { authType: "none" } }
		| { mcp: McpContinuationBase & { authType: "bearer" } }
		| {
				mcp: McpContinuationBase & {
					authType: "oauth";
					oauth?: {
						scope?: string;
						clientName?: string;
						clientRegistration?: "dcr" | "cimd";
						authServerMetadataUrl?: string;
					};
				};
		  }
	);

type OAuthAuthContinuationPayload = Extract<AuthContinuationPayload, { mcp: { authType: "oauth" } }>;
type BearerAuthContinuationPayload = Extract<AuthContinuationPayload, { mcp: { authType: "bearer" } }>;

function isBearerContinuation(payload: AuthContinuationPayload): payload is BearerAuthContinuationPayload {
	return payload.mcp.authType === "bearer";
}

function isOAuthContinuation(payload: AuthContinuationPayload): payload is OAuthAuthContinuationPayload {
	return payload.mcp.authType === "oauth";
}

function asObject(value: unknown, context: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AuthContinueError(`${context} must be a JSON object`);
	}
	return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AuthContinueError(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, field);
}

function requiredAuthType(value: unknown): AuthContinuationPayload["mcp"]["authType"] {
	if (value === "none" || value === "bearer" || value === "oauth") return value;
	throw new AuthContinueError('mcp.authType must be "none", "bearer", or "oauth"');
}

function optionalRegistration(value: unknown, field: string): "dcr" | "cimd" | undefined {
	if (value === undefined) return undefined;
	if (value !== "dcr" && value !== "cimd") throw new AuthContinueError(`${field} must be "dcr" or "cimd"`);
	return value;
}

function normalizeContinuationInput(inputValue: string): string {
	const trimmed = inputValue.trim();
	if (!trimmed) throw new AuthContinueError("Continuation payload is empty");
	const commandMatch = /^\s*pi\s+auth\s+--continue\s+(.+)$/su.exec(trimmed);
	return commandMatch ? commandMatch[1].trim() : trimmed;
}

function decodeBase64Json(inputValue: string): unknown {
	const normalized = normalizeContinuationInput(inputValue);
	if (normalized.startsWith("{")) return JSON.parse(normalized);
	const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
	return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function parseAuthContinuationObject(raw: unknown): AuthContinuationPayload {
	const object = asObject(raw, "Continuation payload");
	if (object.version !== 1) throw new AuthContinueError("version must be 1");
	const base: AuthContinuationBase = {
		version: 1,
		serviceUrl: requiredString(object.serviceUrl, "serviceUrl"),
		providerId: requiredString(object.providerId, "providerId"),
		continuationId: requiredString(object.continuationId, "continuationId"),
		secret: requiredString(object.secret, "secret"),
		returnUrl: requiredString(object.returnUrl, "returnUrl"),
	};
	const mcpRaw = asObject(object.mcp, "mcp");
	const mcpBase: McpContinuationBase = {
		serverUrl: requiredString(mcpRaw.serverUrl, "mcp.serverUrl"),
		serverName: requiredString(mcpRaw.serverName, "mcp.serverName"),
	};
	const authType = requiredAuthType(mcpRaw.authType);
	if (authType === "none") {
		if (mcpRaw.oauth !== undefined) throw new AuthContinueError("mcp.oauth is only valid when mcp.authType is oauth");
		return { ...base, mcp: { ...mcpBase, authType } };
	}
	if (authType === "bearer") {
		if (mcpRaw.oauth !== undefined) throw new AuthContinueError("mcp.oauth is only valid when mcp.authType is oauth");
		return { ...base, mcp: { ...mcpBase, authType } };
	}
	const oauthRaw = mcpRaw.oauth === undefined ? undefined : asObject(mcpRaw.oauth, "mcp.oauth");
	return {
		...base,
		mcp: {
			...mcpBase,
			authType,
			...(oauthRaw
				? {
						oauth: {
							scope: optionalString(oauthRaw.scope, "mcp.oauth.scope"),
							clientName: optionalString(oauthRaw.clientName, "mcp.oauth.clientName"),
							clientRegistration: optionalRegistration(
								oauthRaw.clientRegistration,
								"mcp.oauth.clientRegistration",
							),
							authServerMetadataUrl: optionalString(
								oauthRaw.authServerMetadataUrl,
								"mcp.oauth.authServerMetadataUrl",
							),
						},
					}
				: {}),
		},
	};
}

export function decodeAuthContinuationPayload(inputValue: string): AuthContinuationPayload {
	try {
		return parseAuthContinuationObject(decodeBase64Json(inputValue));
	} catch (error) {
		if (error instanceof AuthContinueError) throw error;
		throw new AuthContinueError(
			`Could not decode continuation payload as base64url JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function readPayloadFromUser(): Promise<string> {
	const rl = createInterface({ input, output });
	try {
		return await rl.question("Paste continuation payload: ");
	} finally {
		rl.close();
	}
}

function normalizeServiceUrl(value: string): string {
	const url = new URL(value);
	url.pathname = url.pathname.replace(/\/$/u, "");
	url.search = "";
	url.hash = "";
	return url.href;
}

function continuationEndpoint(
	payload: AuthContinuationPayload,
	kind: "claim" | "complete",
	serviceUrl: string,
): string {
	const url = new URL(`/v1/auth/continuations/${encodeURIComponent(payload.continuationId)}/${kind}`, serviceUrl);
	return url.href;
}

function credentialFromAuth(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}

function printAuthEvent(event: AuthEvent): void {
	if (event.type === "auth_url") {
		console.log(`\nOpen this URL in your browser:\n${event.url}`);
		if (event.instructions) console.log(event.instructions);
		openBrowser(event.url);
		return;
	}
	if (event.type === "device_code") {
		console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
		console.log(`Enter code: ${event.userCode}`);
		return;
	}
	console.log(event.type === "info" ? event.message : chalk.dim(event.message));
}

async function answerAuthPrompt(rl: Interface, prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		console.log(`\n${prompt.message}`);
		for (let index = 0; index < prompt.options.length; index++) {
			const option = prompt.options[index];
			console.log(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
		}
		const answer = await rl.question(`Enter number (1-${prompt.options.length}): `);
		const selected = prompt.options[Number.parseInt(answer, 10) - 1];
		if (!selected) throw new AuthContinueError("Invalid selection");
		return selected.id;
	}
	return rl.question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `);
}

async function getContinuationServiceToken(providerId: string, signal: AbortSignal): Promise<string> {
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
	let token: string | undefined;
	try {
		token = credentialFromAuth(await runtime.getAuth(providerId, { minOAuthValidityMs: 5 * 60_000, signal }));
	} catch (error) {
		if (signal.aborted) throw error;
		console.log(
			chalk.dim(
				`Stored credential for ${providerId} could not be used: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}
	if (token) return token;
	console.log(chalk.dim("Signing in to the continuation service..."));
	const rl = createInterface({ input, output });
	try {
		await runtime.login(
			providerId,
			"oauth",
			{
				signal,
				prompt: (prompt) => answerAuthPrompt(rl, prompt),
				notify: printAuthEvent,
			},
			{ getDeviceId: () => randomUUID() },
		);
	} finally {
		rl.close();
	}
	token = credentialFromAuth(await runtime.getAuth(providerId, { minOAuthValidityMs: 5 * 60_000, signal }));
	if (!token) throw new AuthContinueError("Sign-in did not produce a bearer token");
	return token;
}

async function postContinuation(
	endpoint: string,
	token: string,
	body: JsonObject,
	signal: AbortSignal,
): Promise<JsonObject> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new AuthContinueError(
			`Continuation request failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ""}`,
		);
	}
	const text = await response.text();
	if (!text.trim()) return {};
	return asObject(JSON.parse(text), "Continuation response");
}

async function completeMcpContinuation(
	payload: AuthContinuationPayload,
	token: string,
	serviceUrl: string,
	body: JsonObject,
	signal: AbortSignal,
): Promise<void> {
	const uploadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	await postContinuation(
		continuationEndpoint(payload, "complete", serviceUrl),
		token,
		{
			continuationId: payload.continuationId,
			secret: payload.secret,
			mcp: {
				serverUrl: payload.mcp.serverUrl,
				serverName: payload.mcp.serverName,
				authType: payload.mcp.authType,
			},
			...body,
		},
		uploadSignal,
	);
}

async function runMcpBearerContinuation(
	payload: BearerAuthContinuationPayload,
	token: string,
	serviceUrl: string,
	signal: AbortSignal,
): Promise<void> {
	const rl = createInterface({ input, output });
	let bearerToken: string;
	try {
		bearerToken = requiredString(
			await rl.question(`Paste bearer token for ${payload.mcp.serverName}: `),
			"bearer token",
		);
	} finally {
		rl.close();
	}
	await completeMcpContinuation(payload, token, serviceUrl, { bearerToken }, signal);
	openBrowser(payload.returnUrl);
	console.log(chalk.green("MCP bearer token uploaded."));
}

async function runMcpOAuthContinuation(
	payload: OAuthAuthContinuationPayload,
	token: string,
	serviceUrl: string,
	signal: AbortSignal,
): Promise<void> {
	const [{ MemoryOAuthStateStore }, { signInMcpServer, McpSignInCancelledError }] = await Promise.all([
		import("@earendil-works/pi-mcp/oauth"),
		import("../extensions/mcp/oauth.ts"),
	]);
	const store = new MemoryOAuthStateStore();
	let state: McpOAuthState | undefined;
	const captureStore = {
		load: () => store.load(),
		save: (next: McpOAuthState) => {
			state = structuredClone(next);
			store.save(next);
		},
	};
	let uploaded = false;
	let browserResponseSent = false;
	const upload = async (): Promise<void> => {
		state ??= store.load();
		if (!state?.tokens) throw new AuthContinueError("MCP sign-in did not produce OAuth tokens");
		console.log(chalk.dim("Uploading MCP authentication to continuation service..."));
		await completeMcpContinuation(payload, token, serviceUrl, { authState: state }, signal);
		uploaded = true;
	};
	const rl = createInterface({ input, output });
	try {
		const result = await signInMcpServer({
			serverUrl: payload.mcp.serverUrl,
			store: captureStore,
			settings: {
				scope: payload.mcp.oauth?.scope,
				clientName: payload.mcp.oauth?.clientName ?? APP_NAME,
				clientRegistration: payload.mcp.oauth?.clientRegistration,
				authServerMetadataUrl: payload.mcp.oauth?.authServerMetadataUrl
					? new URL(payload.mcp.oauth.authServerMetadataUrl)
					: undefined,
			},
			prompt: {
				showAuthorizationUrl(url) {
					console.log(`\nOpen this URL in your browser:\n${url.href}`);
					openBrowser(url.href);
				},
				async promptForRedirectUrl(promptSignal) {
					try {
						return await rl.question(
							"If the browser cannot reach the local callback, paste the final redirect URL here (or press Enter to cancel): ",
							{ signal: promptSignal },
						);
					} catch {
						return undefined;
					}
				},
			},
			afterAuthorization: async () => {
				await upload();
				return payload.returnUrl;
			},
			signal,
		});
		browserResponseSent = result.browserResponseSent;
	} catch (error) {
		if (error instanceof McpSignInCancelledError) throw new AuthContinueError("MCP sign-in cancelled");
		throw error;
	} finally {
		rl.close();
	}
	if (!uploaded) await upload();
	if (!browserResponseSent) openBrowser(payload.returnUrl);
	console.log(chalk.green("MCP authentication uploaded."));
}

async function runMcpContinuation(
	payload: AuthContinuationPayload,
	token: string,
	serviceUrl: string,
	signal: AbortSignal,
): Promise<void> {
	if (isBearerContinuation(payload)) {
		await runMcpBearerContinuation(payload, token, serviceUrl, signal);
		return;
	}
	if (isOAuthContinuation(payload)) {
		await runMcpOAuthContinuation(payload, token, serviceUrl, signal);
		return;
	}
	await completeMcpContinuation(payload, token, serviceUrl, {}, signal);
	openBrowser(payload.returnUrl);
	console.log(chalk.green("MCP connection saved."));
}

export async function runAuthContinuation(payload: AuthContinuationPayload): Promise<void> {
	const serviceUrl = normalizeServiceUrl(payload.serviceUrl);
	const signal = AbortSignal.timeout(15 * 60_000);
	const token = await getContinuationServiceToken(payload.providerId, signal);
	await postContinuation(
		continuationEndpoint(payload, "claim", serviceUrl),
		token,
		{ continuationId: payload.continuationId, secret: payload.secret },
		signal,
	);
	await runMcpContinuation(payload, token, serviceUrl, signal);
}

export async function runAuthContinueCommand(args: string[]): Promise<void> {
	const inputPayload = args.length > 0 ? args.join(" ") : await readPayloadFromUser();
	await runAuthContinuation(decodeAuthContinuationPayload(inputPayload));
}
