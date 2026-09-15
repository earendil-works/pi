/**
 * Terminal reauthentication for durable credentials.
 *
 * A rejected credential must not be retried forever, and it must not be
 * deleted: a transient or misclassified failure would otherwise become
 * irreversible account loss. Instead the rejected credential is marked
 * `needsReauth` and stays unusable until a new login replaces it.
 *
 * The transition is generation-safe. The caller captures the credential that
 * made the request, and the marking runs under the store's serialized
 * `modify`; if the stored credential no longer matches that snapshot, a newer
 * login already landed and the late failure is dropped rather than poisoning
 * the fresh credential.
 */

import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { AuthOperationOptions, Credential, CredentialStore } from "./types.ts";

/** Whether a credential is marked as needing a new login. */
export function isNeedsReauth(credential: Credential | undefined): boolean {
	return credential?.needsReauth === true;
}

/**
 * Field-wise identity comparison. Compares secret material directly rather
 * than building a fingerprint string, so no secret is ever materialized into
 * a loggable value.
 */
export function isSameCredential(left: Credential | undefined, right: Credential | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.type !== right.type) return false;
	if (left.type === "api_key" && right.type === "api_key") {
		return (left.key ?? "") === (right.key ?? "");
	}
	if (left.type === "oauth" && right.type === "oauth") {
		return left.access === right.access && left.refresh === right.refresh;
	}
	return false;
}

/**
 * Mark the credential that made a rejected request as needing reauthentication.
 *
 * `snapshot` is the credential read before the request was issued. When the
 * stored credential differs, a newer login has already replaced it and this
 * call is a no-op — a late `401` from an old request can never mark a freshly
 * reauthorized credential as broken.
 */
export async function markCredentialRejected(
	credentials: CredentialStore,
	providerId: string,
	snapshot: Credential | undefined,
	options?: AuthOperationOptions,
): Promise<void> {
	if (!snapshot || isNeedsReauth(snapshot)) return;
	const result = await credentials.modify(
		providerId,
		async (current) => {
			if (!isSameCredential(current, snapshot)) return undefined; // superseded by a newer login
			return { ...current, needsReauth: true } as Credential;
		},
		options,
	);
	void result;
}

/** Read the stored credential that a request will authenticate with. */
export async function readRequestCredential(
	credentials: CredentialStore,
	providerId: string,
	options?: AuthOperationOptions,
): Promise<Credential | undefined> {
	const signal = operationSignal(options?.signal);
	return raceWithAbortSignal(credentials.read(providerId, { signal }), signal);
}
