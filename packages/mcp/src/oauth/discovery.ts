/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0 src/client/auth.ts.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to remove Zod/CORS shims and enforce authorization-server issuer validation.
 */

import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
import type { McpFetch } from "../transports/streamable-http.ts";
import { OAuthIssuerMismatchError } from "./errors.ts";
import {
	type AuthorizationServerMetadata,
	type OAuthChallenge,
	type OAuthProtectedResourceMetadata,
	type OAuthServerInfo,
	parseAuthorizationServerMetadata,
	parseProtectedResourceMetadata,
} from "./types.ts";

function discard(response: Response | undefined): void {
	void response?.body?.cancel().catch(() => {});
}

function field(header: string, name: string): string | undefined {
	const match = header.match(new RegExp(String.raw`(?:^|[,\s])${name}=(?:"([^"]*)"|([^\s,]+))`, "i"));
	return match?.[1] ?? match?.[2];
}

export function parseWwwAuthenticate(header: string | null): OAuthChallenge {
	if (!header) return {};
	const scheme = header.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
	if (scheme !== "bearer" && scheme !== "dpop") return {};
	const resourceMetadata = field(header, "resource_metadata");
	let resourceMetadataUrl: URL | undefined;
	if (resourceMetadata) {
		try {
			resourceMetadataUrl = new URL(resourceMetadata);
		} catch {}
	}
	return {
		resourceMetadataUrl,
		scope: field(header, "scope"),
		error: field(header, "error"),
		errorDescription: field(header, "error_description"),
	};
}

function metadataPath(kind: "oauth-protected-resource" | "oauth-authorization-server", pathname: string): string {
	const path = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	return `/.well-known/${kind}${path}`;
}

async function fetchMetadata(url: URL, fetch: McpFetch, protocolVersion: string): Promise<Response> {
	return fetch(url, {
		headers: { Accept: "application/json", "MCP-Protocol-Version": protocolVersion },
	});
}

export async function discoverProtectedResourceMetadata(
	serverUrl: string | URL,
	options: { resourceMetadataUrl?: string | URL; protocolVersion?: string; fetch?: McpFetch } = {},
): Promise<OAuthProtectedResourceMetadata> {
	const server = new URL(serverUrl);
	const fetch = options.fetch ?? globalThis.fetch;
	const version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
	let response = await fetchMetadata(
		options.resourceMetadataUrl
			? new URL(options.resourceMetadataUrl)
			: new URL(metadataPath("oauth-protected-resource", server.pathname), server.origin),
		fetch,
		version,
	);
	if (
		!options.resourceMetadataUrl &&
		server.pathname !== "/" &&
		((response.status >= 400 && response.status < 500) || response.status === 502)
	) {
		discard(response);
		response = await fetchMetadata(new URL("/.well-known/oauth-protected-resource", server.origin), fetch, version);
	}
	if (!response.ok) {
		discard(response);
		throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
	}
	return parseProtectedResourceMetadata(await response.json());
}

export function buildAuthorizationServerDiscoveryUrls(
	authorizationServerUrl: string | URL,
): { url: URL; type: "oauth" | "oidc" }[] {
	const issuer = new URL(authorizationServerUrl);
	if (issuer.pathname === "/") {
		return [
			{ url: new URL("/.well-known/oauth-authorization-server", issuer.origin), type: "oauth" },
			{ url: new URL("/.well-known/openid-configuration", issuer.origin), type: "oidc" },
		];
	}
	const path = issuer.pathname.endsWith("/") ? issuer.pathname.slice(0, -1) : issuer.pathname;
	return [
		{ url: new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin), type: "oauth" },
		{ url: new URL(`/.well-known/openid-configuration${path}`, issuer.origin), type: "oidc" },
		{ url: new URL(`${path}/.well-known/openid-configuration`, issuer.origin), type: "oidc" },
	];
}

export async function discoverAuthorizationServerMetadata(
	authorizationServerUrl: string | URL,
	options: { fetch?: McpFetch; protocolVersion?: string; skipIssuerValidation?: boolean } = {},
): Promise<AuthorizationServerMetadata | undefined> {
	const fetch = options.fetch ?? globalThis.fetch;
	for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
		const response = await fetchMetadata(url, fetch, options.protocolVersion ?? LATEST_PROTOCOL_VERSION);
		if (!response.ok) {
			discard(response);
			if ((response.status >= 400 && response.status < 500) || response.status === 502) continue;
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		if (!options.skipIssuerValidation) {
			const expected = String(authorizationServerUrl);
			if (metadata.issuer !== expected && !(expected.endsWith("/") && metadata.issuer === expected.slice(0, -1))) {
				throw new OAuthIssuerMismatchError(expected, metadata.issuer);
			}
		}
		return metadata;
	}
	return undefined;
}

export async function discoverOAuthServerInfo(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: URL;
		fetch?: McpFetch;
		skipIssuerValidation?: boolean;
	} = {},
): Promise<OAuthServerInfo> {
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	try {
		resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, {
			resourceMetadataUrl: options.resourceMetadataUrl,
			fetch: options.fetch,
		});
	} catch (error) {
		if (error instanceof TypeError) throw error;
	}
	const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? String(new URL("/", serverUrl));
	return {
		authorizationServerUrl,
		authorizationServerMetadata: await discoverAuthorizationServerMetadata(authorizationServerUrl, {
			fetch: options.fetch,
			skipIssuerValidation: options.skipIssuerValidation,
		}),
		resourceMetadata,
	};
}

export function resourceUrlFromServerUrl(value: string | URL): URL {
	const url = new URL(value);
	url.hash = "";
	return url;
}

export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
	if (!metadata) return undefined;
	const requested = resourceUrlFromServerUrl(serverUrl);
	const configured = new URL(metadata.resource);
	if (requested.origin !== configured.origin) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
	const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
	if (!requestedPath.startsWith(configuredPath)) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	return metadata.resource;
}
