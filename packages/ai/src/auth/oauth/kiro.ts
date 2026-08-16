import { getKiroEndpoints, resolveKiroApiRegion } from "../../providers/kiro.shared.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT = "refresh_token";
const SSO_SCOPES = [
	"codewhisperer:completions",
	"codewhisperer:analysis",
	"codewhisperer:conversations",
	"codewhisperer:transformations",
	"codewhisperer:taskassist",
];
const REGION_PROBES = [
	"us-east-1",
	"eu-west-1",
	"eu-central-1",
	"us-east-2",
	"eu-west-2",
	"eu-west-3",
	"eu-north-1",
	"ap-southeast-1",
	"ap-northeast-1",
	"us-west-2",
] as const;
const LOGIN_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;

export interface KiroOAuthCredential extends OAuthCredential {
	clientId: string;
	clientSecret: string;
	region: string;
	authMethod: "idc";
	profileArn?: string;
}

type KiroDeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	interval: number;
	expiresIn: number;
};

type KiroTokenResponse = {
	accessToken?: string;
	access_token?: string;
	refreshToken?: string;
	refresh_token?: string;
	expiresIn?: number;
	expires_in?: number;
	error?: string;
	error_description?: string;
};

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS)]);
}

function getField<T>(response: Record<string, unknown>, camel: string, snake: string): T | undefined {
	const camelValue = response[camel];
	if (camelValue !== undefined) return camelValue as T;
	return response[snake] as T | undefined;
}

async function readJson<T>(response: Response): Promise<T> {
	try {
		return (await response.json()) as T;
	} catch {
		return {} as T;
	}
}

async function registerAndAuthorize(
	startUrl: string,
	region: string,
	fetchFn: typeof globalThis.fetch,
	signal: AbortSignal,
): Promise<{ clientId: string; clientSecret: string; device: KiroDeviceAuthorization } | undefined> {
	const oidcEndpoint = `https://oidc.${region}.amazonaws.com`;
	const registerResponse = await fetchFn(`${oidcEndpoint}/client/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
		body: JSON.stringify({
			clientName: "pi-cli",
			clientType: "public",
			scopes: SSO_SCOPES,
			grantTypes: [DEVICE_CODE_GRANT, REFRESH_GRANT],
		}),
		signal: requestSignal(signal),
	});
	if (!registerResponse.ok) return undefined;
	const registration = (await readJson<Record<string, unknown>>(registerResponse)) as Record<string, unknown>;
	const clientId = getField<string>(registration, "clientId", "client_id");
	const clientSecret = getField<string>(registration, "clientSecret", "client_secret");
	if (!clientId || !clientSecret) return undefined;

	const deviceResponse = await fetchFn(`${oidcEndpoint}/device_authorization`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
		body: JSON.stringify({ clientId, clientSecret, startUrl }),
		signal: requestSignal(signal),
	});
	if (!deviceResponse.ok) return undefined;
	const raw = (await readJson<Record<string, unknown>>(deviceResponse)) as Record<string, unknown>;
	const deviceCode = getField<string>(raw, "deviceCode", "device_code");
	const userCode = getField<string>(raw, "userCode", "user_code");
	const verificationUri = getField<string>(raw, "verificationUri", "verification_uri");
	const verificationUriComplete = getField<string>(raw, "verificationUriComplete", "verification_uri_complete");
	const interval = Number(getField<number | string>(raw, "interval", "interval") ?? 5);
	const expiresIn = Number(getField<number | string>(raw, "expiresIn", "expires_in") ?? 600);
	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!verificationUriComplete ||
		!Number.isFinite(interval) ||
		!Number.isFinite(expiresIn)
	) {
		return undefined;
	}
	return {
		clientId,
		clientSecret,
		device: {
			deviceCode,
			userCode,
			verificationUri,
			verificationUriComplete,
			interval: Math.max(1, interval),
			expiresIn: Math.max(1, expiresIn),
		},
	};
}

async function beginDeviceAuthorization(
	startUrl: string,
	preferredRegion: string | undefined,
	fetchFn: typeof globalThis.fetch,
	signal: AbortSignal,
): Promise<{ region: string; clientId: string; clientSecret: string; device: KiroDeviceAuthorization }> {
	const regions = preferredRegion ? [preferredRegion] : [...REGION_PROBES];
	for (const region of regions) {
		try {
			const result = await registerAndAuthorize(startUrl, region, fetchFn, signal);
			if (result) return { region, ...result };
		} catch (error) {
			if (signal.aborted) throw error;
			// A region that cannot be reached or does not own the start URL is not
			// fatal while probing the remaining Identity Center regions.
		}
	}
	throw new Error("Could not find an AWS Identity Center region for the supplied start URL");
}

async function pollForToken(
	flow: { region: string; clientId: string; clientSecret: string; device: KiroDeviceAuthorization },
	fetchFn: typeof globalThis.fetch,
	signal: AbortSignal,
): Promise<KiroOAuthCredential> {
	return pollOAuthDeviceCodeFlow<KiroOAuthCredential>({
		intervalSeconds: flow.device.interval,
		expiresInSeconds: flow.device.expiresIn,
		signal,
		poll: async () => {
			const response = await fetchFn(`https://oidc.${flow.region}.amazonaws.com/token`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
				body: JSON.stringify({
					clientId: flow.clientId,
					clientSecret: flow.clientSecret,
					deviceCode: flow.device.deviceCode,
					grantType: DEVICE_CODE_GRANT,
				}),
				signal: requestSignal(signal),
			});
			const data = await readJson<KiroTokenResponse>(response);
			const error = data.error;
			if (response.ok && !error) {
				const access = data.accessToken ?? data.access_token;
				const refresh = data.refreshToken ?? data.refresh_token;
				const expiresIn = Number(data.expiresIn ?? data.expires_in);
				if (!access || !refresh || !Number.isFinite(expiresIn)) {
					return { status: "failed", message: "Kiro token response was missing required fields" };
				}
				return {
					status: "complete",
					value: {
						type: "oauth",
						access,
						refresh: `${refresh}|${flow.clientId}|${flow.clientSecret}|idc|${flow.region}`,
						expires: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS,
						clientId: flow.clientId,
						clientSecret: flow.clientSecret,
						region: flow.region,
						authMethod: "idc",
					},
				};
			}
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			return {
				status: "failed",
				message: `Kiro authorization failed${error ? `: ${error}` : ` (HTTP ${response.status})`}`,
			};
		},
	});
}

async function loginKiro(interaction: ProviderAuthInteraction): Promise<KiroOAuthCredential> {
	interaction.signal.throwIfAborted();
	const startUrlInput = await interaction.prompt({
		type: "text",
		message: "Paste your IAM Identity Center start URL, or leave blank for AWS Builder ID",
		placeholder: BUILDER_ID_START_URL,
	});
	interaction.signal.throwIfAborted();
	const startUrl = startUrlInput.trim() || BUILDER_ID_START_URL;
	if (!/^https?:\/\//i.test(startUrl)) throw new Error("Kiro start URL must be an http(s) URL");

	let preferredRegion: string | undefined;
	if (startUrl !== BUILDER_ID_START_URL) {
		const regionInput = await interaction.prompt({
			type: "text",
			message: "AWS Identity Center region (leave blank to auto-detect)",
			placeholder: "us-east-1",
		});
		preferredRegion = regionInput.trim() || undefined;
	}
	const fetchFn = globalThis.fetch;
	const flow = await beginDeviceAuthorization(startUrl, preferredRegion, fetchFn, interaction.signal);
	interaction.notify({
		type: "auth_url",
		url: flow.device.verificationUriComplete,
		instructions: `Your code: ${flow.device.userCode}`,
	});
	interaction.notify({ type: "progress", message: `Waiting for Kiro authorization in ${flow.region}...` });
	return pollForToken(flow, fetchFn, interaction.signal);
}

function parseRefreshCredential(credential: OAuthCredential): {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	region: string;
} {
	const kiroCredential = credential as KiroOAuthCredential;
	const parts = credential.refresh.split("|");
	const refreshToken = parts[0];
	const clientId = kiroCredential.clientId ?? parts[1];
	const clientSecret = kiroCredential.clientSecret ?? parts[2];
	const region = kiroCredential.region ?? (parts[3] === "idc" ? parts[4] : undefined);
	if (!refreshToken || !clientId || !clientSecret || !region) {
		throw new Error("Kiro OAuth credential is missing Identity Center refresh metadata; run /login kiro again");
	}
	return { refreshToken, clientId, clientSecret, region };
}

async function refreshKiroToken(credential: OAuthCredential, signal: AbortSignal): Promise<KiroOAuthCredential> {
	const { refreshToken, clientId, clientSecret, region } = parseRefreshCredential(credential);
	const response = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": "pi-cli" },
		body: JSON.stringify({ clientId, clientSecret, refreshToken, grantType: REFRESH_GRANT }),
		signal: requestSignal(signal),
	});
	const data = await readJson<KiroTokenResponse>(response);
	if (!response.ok) throw new Error(`Kiro token refresh failed (HTTP ${response.status})`);
	const access = data.accessToken ?? data.access_token;
	const refresh = data.refreshToken ?? data.refresh_token ?? refreshToken;
	const expiresIn = Number(data.expiresIn ?? data.expires_in);
	if (!access || !Number.isFinite(expiresIn))
		throw new Error("Kiro token refresh response was missing required fields");
	return {
		type: "oauth",
		access,
		refresh: `${refresh}|${clientId}|${clientSecret}|idc|${region}`,
		expires: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS,
		clientId,
		clientSecret,
		region,
		authMethod: "idc",
		profileArn: (credential as KiroOAuthCredential).profileArn,
	};
}

export const kiroOAuth: OAuthAuth = {
	name: "Kiro (AWS Builder ID / IAM Identity Center)",
	isSubscription: true,
	login: loginKiro,
	refresh: refreshKiroToken,
	async toAuth(credential: OAuthCredential) {
		const kiroCredential = credential as KiroOAuthCredential;
		const region = resolveKiroApiRegion(kiroCredential.region);
		return {
			apiKey: credential.access,
			baseUrl: getKiroEndpoints(region).runtime,
			headers: kiroCredential.profileArn ? { "x-amzn-kiro-profile-arn": kiroCredential.profileArn } : undefined,
		};
	},
};
