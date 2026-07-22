import type { Credential, CredentialInfo, CredentialStore } from "./types.ts";

/**
 * Default in-memory credential store. Apps inject persistent stores.
 * Keyed by `Provider.id`, one credential per provider; see `CredentialStore`.
 * Writes are serialized per provider through a promise chain.
 */
export class InMemoryCredentialStore implements CredentialStore {
	private credentials = new Map<string, Credential>();
	private chains = new Map<string, Promise<unknown>>();

	/** Serialize tasks per provider id. */
	private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = (async () => {
			await previous.catch(() => {});
			return task();
		})();
		this.chains.set(
			providerId,
			next.catch(() => {}),
		);
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.credentials.get(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.enqueue(providerId, async () => {
			const current = this.credentials.get(providerId);
			const next = await fn(current);
			if (next !== undefined) this.credentials.set(providerId, next);
			return next ?? current;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.enqueue(providerId, async () => {
			this.credentials.delete(providerId);
		});
	}
}
