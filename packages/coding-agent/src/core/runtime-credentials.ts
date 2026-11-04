import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();
	/** Modifications whose update function has started, for example an OAuth token request. */
	private readonly startedModifications = new Set<Promise<void>>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let markDone!: () => void;
		const done = new Promise<void>((resolve) => {
			markDone = resolve;
		});
		const modification = this.store.modify(
			providerId,
			(current) => {
				this.startedModifications.add(done);
				return fn(current);
			},
			options,
		);
		const finish = () => {
			this.startedModifications.delete(done);
			markDone();
		};
		modification.then(finish, finish);
		return modification;
	}

	/**
	 * Wait until every modification whose update function has started is written or failed.
	 *
	 * A modification still waiting for the store lock is not awaited: it has not sent anything yet.
	 * One that has started may have spent a single-use OAuth refresh token, so exiting before its
	 * result is written would leave only the spent token in auth.json.
	 */
	async settled(): Promise<void> {
		while (this.startedModifications.size > 0) {
			await Promise.all(this.startedModifications);
		}
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
