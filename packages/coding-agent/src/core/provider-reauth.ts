/**
 * Terminal reauthentication helper for the request funnel.
 *
 * A durable credential that the provider rejected is marked as needing a new
 * login rather than being retried or deleted. This reads the credential that is
 * about to authenticate a request, and marks exactly that credential if the
 * request comes back rejected. Because the marking is generation-checked inside
 * the store's serialized write, a late response from an older request can never
 * mark a credential that a newer login already replaced.
 */

import { type CredentialStore, markCredentialRejected, readRequestCredential } from "@earendil-works/pi-ai";

/** Anything that can expose the credential store backing a provider. */
export interface CredentialStoreSource {
	credentialStore(): CredentialStore;
}

/**
 * Mark the provider's stored credential as needing reauthentication.
 *
 * Never throws: this runs from a response callback, and a bookkeeping failure
 * must not turn a provider error into a crash.
 */
export async function markProviderCredentialRejected(source: CredentialStoreSource, providerId: string): Promise<void> {
	try {
		const store = source.credentialStore();
		const snapshot = await readRequestCredential(store, providerId, { signal: AbortSignal.timeout(5_000) });
		if (!snapshot) return;
		await markCredentialRejected(store, providerId, snapshot, { signal: AbortSignal.timeout(5_000) });
	} catch {
		// Best-effort bookkeeping.
	}
}
