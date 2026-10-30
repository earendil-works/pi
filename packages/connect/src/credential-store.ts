/// <reference lib="dom" />

// pi-ai's CredentialStore in IndexedDB, serialized across tabs with Web Locks.

import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { ConnectDatabase } from "./database.ts";

/**
 * pi-ai refreshes an OAuth token inside `modify`, and some providers rotate the refresh token on
 * every refresh. Two tabs refreshing at once would both spend the same refresh token, and the slower
 * one would store a token the provider has already revoked. A Web Lock per provider makes the read,
 * the refresh and the write one critical section across every tab of the origin. An IndexedDB
 * transaction cannot span the refresh's network request, so the lock provides the exclusion and each
 * read and write is its own transaction. As pi-ai requires, a signal cancels only the wait for the lock.
 */
export class IndexedDbCredentialStore implements CredentialStore {
	private readonly database: ConnectDatabase;
	private readonly lockPrefix: string;
	private readonly locks: LockManager;

	/** `lockPrefix` names this database's locks, so two databases on one origin do not wait for each other. */
	constructor(database: ConnectDatabase, lockPrefix: string, locks: LockManager = navigator.locks) {
		this.database = database;
		this.lockPrefix = lockPrefix;
		this.locks = locks;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		// Only this store writes the credentials store of its database.
		return (await this.database.get("credentials", providerId)) as Credential | undefined;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const infos: CredentialInfo[] = [];
		for (const providerId of await this.database.keys("credentials")) {
			const credential = await this.read(providerId, options);
			if (credential) infos.push({ providerId, type: credential.type });
		}
		return infos;
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.locks.request(this.lockName(providerId), { signal: options?.signal }, async () => {
			const current = await this.read(providerId);
			const next = await fn(current);
			if (next !== undefined) await this.database.put("credentials", providerId, next);
			return next ?? current;
		});
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.locks.request(this.lockName(providerId), { signal: options?.signal }, () =>
			this.database.delete("credentials", providerId),
		);
	}

	private lockName(providerId: string): string {
		return `${this.lockPrefix}:credential:${providerId}`;
	}
}
