/**
 * GitHub Copilot OAuth flow
 */
import { getModels } from "../../models.js";
import { saveOAuthCredentials } from "./storage.js";

const decode = (s) => Buffer.from(s, "base64").toString();
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");
const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};
export function normalizeDomain(input) {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}
function getUrls(domain) {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}
/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * Returns API URL like https://api.individual.githubcopilot.com
 */
export function getBaseUrlFromToken(token) {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	const proxyHost = match[1];
	// Convert proxy.xxx to api.xxx
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}
export function getGitHubCopilotBaseUrl(token, enterpriseDomain) {
	// If we have a token, extract the base URL from proxy-ep
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	// Fallback for enterprise or if token parsing fails
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}
async function fetchJson(url, init) {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}
async function startDeviceFlow(domain) {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});
	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}
	const deviceCode = data.device_code;
	const userCode = data.user_code;
	const verificationUri = data.verification_uri;
	const interval = data.interval;
	const expiresIn = data.expires_in;
	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}
	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}
async function pollForGitHubAccessToken(domain, deviceCode, intervalSeconds, expiresIn) {
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
	while (Date.now() < deadline) {
		const raw = await fetchJson(urls.accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "GitHubCopilotChat/0.35.0",
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});
		if (raw && typeof raw === "object" && typeof raw.access_token === "string") {
			return raw.access_token;
		}
		if (raw && typeof raw === "object" && typeof raw.error === "string") {
			const err = raw.error;
			if (err === "authorization_pending") {
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
				continue;
			}
			if (err === "slow_down") {
				intervalMs += 5000;
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
				continue;
			}
			throw new Error(`Device flow failed: ${err}`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error("Device flow timed out");
}
/**
 * Refresh GitHub Copilot token
 */
export async function refreshGitHubCopilotToken(refreshToken, enterpriseDomain) {
	const domain = enterpriseDomain || "github.com";
	const urls = getUrls(domain);
	const raw = await fetchJson(urls.copilotTokenUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...COPILOT_HEADERS,
		},
	});
	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid Copilot token response");
	}
	const token = raw.token;
	const expiresAt = raw.expires_at;
	if (typeof token !== "string" || typeof expiresAt !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}
	return {
		type: "oauth",
		refresh: refreshToken,
		access: token,
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}
/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
export async function enableGitHubCopilotModel(token, modelId, enterpriseDomain) {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}
/**
 * Enable all known GitHub Copilot models that may require policy acceptance.
 * Called after successful login to ensure all models are available.
 */
export async function enableAllGitHubCopilotModels(token, enterpriseDomain, onProgress) {
	const models = getModels("github-copilot");
	await Promise.all(
		models.map(async (model) => {
			const success = await enableGitHubCopilotModel(token, model.id, enterpriseDomain);
			onProgress?.(model.id, success);
		}),
	);
}
/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 */
export async function loginGitHubCopilot(options) {
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});
	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) {
		throw new Error("Invalid GitHub Enterprise URL/domain");
	}
	const domain = enterpriseDomain || "github.com";
	const device = await startDeviceFlow(domain);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);
	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
	);
	const credentials = await refreshGitHubCopilotToken(githubAccessToken, enterpriseDomain ?? undefined);
	// Enable all models after successful login
	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(credentials.access, enterpriseDomain ?? undefined);
	// Save credentials
	saveOAuthCredentials("github-copilot", credentials);
	return credentials;
}
//# sourceMappingURL=github-copilot.js.map
