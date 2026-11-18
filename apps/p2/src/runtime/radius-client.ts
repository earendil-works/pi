// A Pi client of Radius: the client channel to one of the user's servers (`pi-server.client.v2`), which the TUI
// launcher (src/hosts/tui-radius.ts) and p2's connections to machines running `pi-env agent` (plugins/envs) open, the
// user's OAuth client for the gateway, and this p2's owner at Radius (`ownerRadiusAccess`).
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { WebSocket } from "ws";
import { readRadiusConfig } from "./radius-config.ts";

/** A signed-in Radius user: the gateway and a current access token. */
export type RadiusClient = {
	readonly gateway: string;
	access(): Promise<string>;
};

/** Refresh an access token this long before it expires. */
export const RADIUS_REFRESH_MARGIN_MS = 5 * 60_000;

/** Radius's limit for one message. */
export const RADIUS_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const CLIENT_SUBPROTOCOL = "pi-server.client.v2";

/**
 * A client channel to server `serverId` through Radius, authenticated with `token`. Radius refuses the upgrade with an
 * HTTP status (`unexpected-response`): 401 for an invalid sign-in, 403 when the server refused the channel, 503 while
 * the server is not connected.
 */
export function radiusClientChannel(gateway: string, serverId: string, token: string): WebSocket {
	const url = new URL(`/v1/servers/${encodeURIComponent(serverId)}/connect`, gateway);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return new WebSocket(url, CLIENT_SUBPROTOCOL, {
		headers: { authorization: `Bearer ${token}` },
		maxPayload: RADIUS_MAX_MESSAGE_BYTES,
		handshakeTimeout: 10_000,
		followRedirects: false,
	});
}

/** The Radius OAuth client (device-code sign-in and refresh) for `gateway`. */
export function radiusOAuth(gateway: string) {
	const oauth = radiusProvider({ gateway }).auth.oauth;
	if (!oauth) throw new Error("The Radius provider has no OAuth support");
	return oauth;
}

/** Whether `credential` must be refreshed before use. */
export function radiusCredentialExpiring(credential: OAuthCredential): boolean {
	return credential.expires - Date.now() <= RADIUS_REFRESH_MARGIN_MS;
}

/**
 * A signed-in Radius user's credential as `load` reads it now (`undefined`: signed out), with a current access token:
 * one about to expire is refreshed, one refresh at a time, and handed to `save` when given (which returns what it
 * stored); without `save` the refreshed credential is kept in memory for as long as `load` reads the refresh token it
 * came from (Radius does not rotate refresh tokens). `signal` abandons a refresh in flight.
 */
export function radiusCredentials<T extends { readonly gateway: string; readonly credential: OAuthCredential }>(
	load: () => Promise<T | undefined>,
	options: { save?: (current: T, credential: OAuthCredential) => Promise<T>; signal?: AbortSignal } = {},
): () => Promise<T | undefined> {
	let refreshed: { readonly from: string; readonly value: T } | undefined;
	let refreshing: Promise<T> | undefined;
	return async () => {
		const current = await load();
		if (current === undefined || !radiusCredentialExpiring(current.credential)) return current;
		const from = current.credential.refresh;
		if (refreshed?.from === from && !radiusCredentialExpiring(refreshed.value.credential)) return refreshed.value;
		refreshing ??= (async () => {
			const signal = AbortSignal.any([
				...(options.signal ? [options.signal] : []),
				AbortSignal.timeout(REFRESH_TIMEOUT_MS),
			]);
			const credential: OAuthCredential = {
				...(await radiusOAuth(current.gateway).refresh(current.credential, signal)),
				type: "oauth",
			};
			const value = options.save ? await options.save(current, credential) : { ...current, credential };
			refreshed = { from, value };
			return value;
		})().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	};
}

const REFRESH_TIMEOUT_MS = 30_000;

/**
 * This p2's owner at Radius, for what p2 opens as a Pi client of its owner rather than as a brain: connections to the
 * owner's machines running `pi-env agent` and Radius's API on the owner's behalf (listing them, enrollment codes). The
 * gateway, this p2's own server ID (its name at Radius) and a current access token of its owner.
 */
export type OwnerRadius = { readonly gateway: string; readonly serverId: string; readonly token: string };

/** One access per data directory and process, so its refreshes are shared (`ownerRadiusAccess`). */
const owners = new Map<string, () => Promise<OwnerRadius>>();

/**
 * The owner's Radius access from `directory`'s radius.json, read at every call so a new sign-in applies at once; one per
 * directory and process (the server, a session worker, the terminal host). A refreshed token stays in memory: the brain
 * refreshes and saves radius.json on its own schedule. Rejects while this p2 is not signed in to Radius.
 */
export function ownerRadiusAccess(directory: string): () => Promise<OwnerRadius> {
	let access = owners.get(directory);
	if (access === undefined) {
		const credentials = radiusCredentials(() => readRadiusConfig(directory));
		access = async () => {
			const config = await credentials();
			if (!config) throw new Error("This p2 is not signed in to Radius (npm run radius:login)");
			return { gateway: config.gateway, serverId: config.serverId, token: config.credential.access };
		};
		owners.set(directory, access);
	}
	return access;
}
