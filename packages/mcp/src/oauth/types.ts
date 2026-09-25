/*
 * Adapted from modelcontextprotocol/typescript-sdk v1.29.0.
 * Copyright (c) 2024 Anthropic, PBC. Licensed under MIT; see LICENSES/.
 * Modified to use dependency-free structural validation.
 */

import { isObject } from "../protocol/jsonrpc.ts";

export interface OAuthProtectedResourceMetadata {
	resource: string;
	authorization_servers?: string[];
	scopes_supported?: string[];
	[key: string]: unknown;
}

export interface AuthorizationServerMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	response_types_supported: string[];
	grant_types_supported?: string[];
	token_endpoint_auth_methods_supported?: string[];
	code_challenge_methods_supported?: string[];
	client_id_metadata_document_supported?: boolean;
	[key: string]: unknown;
}

export interface OAuthTokens {
	access_token: string;
	token_type: string;
	expires_in?: number;
	scope?: string;
	refresh_token?: string;
	id_token?: string;
}

export interface OAuthClientMetadata {
	redirect_uris: string[];
	token_endpoint_auth_method?: string;
	grant_types?: string[];
	response_types?: string[];
	client_name?: string;
	client_uri?: string;
	logo_uri?: string;
	scope?: string;
	contacts?: string[];
	tos_uri?: string;
	policy_uri?: string;
	jwks_uri?: string;
	jwks?: unknown;
	software_id?: string;
	software_version?: string;
	software_statement?: string;
}

export interface OAuthClientInformation {
	client_id: string;
	client_secret?: string;
	client_id_issued_at?: number;
	client_secret_expires_at?: number;
}

export type OAuthClientInformationFull = OAuthClientInformation & OAuthClientMetadata;
export type OAuthClientInformationMixed = OAuthClientInformation | OAuthClientInformationFull;

export interface OAuthDiscoveryState {
	authorizationServerUrl: string;
	authorizationServerMetadata?: AuthorizationServerMetadata;
	resourceMetadata?: OAuthProtectedResourceMetadata;
	resourceMetadataUrl?: string;
}

export interface OAuthServerInfo {
	authorizationServerUrl: string;
	authorizationServerMetadata?: AuthorizationServerMetadata;
	resourceMetadata?: OAuthProtectedResourceMetadata;
}

export interface OAuthChallenge {
	resourceMetadataUrl?: URL;
	scope?: string;
	error?: string;
	errorDescription?: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (!isObject(value)) throw new Error(`Invalid ${name}`);
	return value;
}

/** Drops `undefined` values so optional fields are absent rather than present-but-undefined. */
function compact<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${name}`);
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, name);
}

function optionalStrings(value: unknown, name: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Invalid ${name}`);
	return [...value];
}

function safeUrl(value: unknown, name: string): string {
	const text = requiredString(value, name);
	const url = new URL(text);
	if (["javascript:", "data:", "vbscript:"].includes(url.protocol)) throw new Error(`Invalid ${name}`);
	return text;
}

function optionalUrl(value: unknown, name: string): string | undefined {
	return value === undefined ? undefined : safeUrl(value, name);
}

export function parseProtectedResourceMetadata(value: unknown): OAuthProtectedResourceMetadata {
	const input = object(value, "OAuth protected resource metadata");
	return compact({
		...input,
		resource: safeUrl(input.resource, "OAuth protected resource metadata resource"),
		authorization_servers: optionalStrings(input.authorization_servers, "authorization_servers")?.map((url) =>
			safeUrl(url, "authorization server URL"),
		),
		scopes_supported: optionalStrings(input.scopes_supported, "scopes_supported"),
	});
}

export function parseAuthorizationServerMetadata(value: unknown): AuthorizationServerMetadata {
	const input = object(value, "authorization server metadata");
	const responseTypes = optionalStrings(input.response_types_supported, "response_types_supported");
	if (!responseTypes) throw new Error("Invalid response_types_supported");
	return compact({
		...input,
		issuer: safeUrl(input.issuer, "authorization server issuer"),
		authorization_endpoint: safeUrl(input.authorization_endpoint, "authorization endpoint"),
		token_endpoint: safeUrl(input.token_endpoint, "token endpoint"),
		registration_endpoint: optionalUrl(input.registration_endpoint, "registration endpoint"),
		scopes_supported: optionalStrings(input.scopes_supported, "scopes_supported"),
		response_types_supported: responseTypes,
		grant_types_supported: optionalStrings(input.grant_types_supported, "grant_types_supported"),
		token_endpoint_auth_methods_supported: optionalStrings(
			input.token_endpoint_auth_methods_supported,
			"token_endpoint_auth_methods_supported",
		),
		code_challenge_methods_supported: optionalStrings(
			input.code_challenge_methods_supported,
			"code_challenge_methods_supported",
		),
		client_id_metadata_document_supported:
			typeof input.client_id_metadata_document_supported === "boolean"
				? input.client_id_metadata_document_supported
				: undefined,
	});
}

export function parseOAuthTokens(value: unknown): OAuthTokens {
	const input = object(value, "OAuth token response");
	const expires = input.expires_in === undefined ? undefined : Number(input.expires_in);
	if (expires !== undefined && !Number.isFinite(expires)) throw new Error("Invalid expires_in");
	return compact({
		access_token: requiredString(input.access_token, "access_token"),
		token_type: requiredString(input.token_type, "token_type"),
		expires_in: expires,
		scope: optionalString(input.scope, "scope"),
		refresh_token: optionalString(input.refresh_token, "refresh_token"),
		id_token: optionalString(input.id_token, "id_token"),
	});
}

export function parseClientInformation(value: unknown): OAuthClientInformationFull {
	const input = object(value, "OAuth client registration response");
	return compact({
		...(input as unknown as OAuthClientMetadata),
		client_id: requiredString(input.client_id, "client_id"),
		client_secret: optionalString(input.client_secret, "client_secret"),
		client_id_issued_at: typeof input.client_id_issued_at === "number" ? input.client_id_issued_at : undefined,
		client_secret_expires_at:
			typeof input.client_secret_expires_at === "number" ? input.client_secret_expires_at : undefined,
		redirect_uris: optionalStrings(input.redirect_uris, "redirect_uris") ?? [],
	});
}
