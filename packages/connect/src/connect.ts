/// <reference lib="dom" />

// A pi-ai Models collection for browsers: credentials in IndexedDB, sign-in through pi.dev.

import {
	type AuthOperationOptions,
	type Credential,
	createModels,
	type ModelsRefreshResult,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai";
import { registerOAuthFlows } from "@earendil-works/pi-ai/oauth-flows";
import { withRemoteCatalog } from "@earendil-works/pi-ai/remote-catalog";
import { BUILTIN_AUTH_DOCUMENTS } from "./builtin-documents.ts";
import { IndexedDbCredentialStore } from "./credential-store.ts";
import { ConnectDatabase } from "./database.ts";
import { type AuthDocuments, parseAuthDocuments } from "./documents.ts";
import { ConnectError } from "./errors.ts";
import { IndexedDbModelsStore } from "./models-store.ts";
import { type PopupHost, signInWithPopup } from "./popup.ts";
import { relayFetch } from "./relay.ts";
import { describeSupport, type ProviderSupport } from "./support.ts";

export interface ConnectOptions {
	/**
	 * The providers to offer. Their API-key auth stays as configured; their OAuth flows run from this
	 * bundle, with the requests browsers cannot send going through pi.dev's relay.
	 */
	providers: readonly Provider[];
	/** Where auth documents, model catalogs, the relay and the sign-in popup live. Default: https://pi.dev */
	piUrl?: string;
	/** Offer sign-ins that end with pasting the address of a page that fails to load. Default: false. */
	manual?: boolean;
	/** IndexedDB database name. Default: "pi-connect". */
	database?: string;
	/** Layer pi.dev's model catalogs over providers that have no catalog of their own. Default: true. */
	catalogs?: boolean;
	/** For tests: the IndexedDB factory, the lock manager and the window that opens the popup. */
	indexedDB?: IDBFactory;
	locks?: LockManager;
	window?: PopupHost;
}

export interface Connect {
	/** The Models collection to hand to pi-ai or pi-durable. */
	readonly models: MutableModels;
	/** The auth documents in use: the newest of the bundled, the cached and the fetched ones. */
	readonly documents: AuthDocuments;
	/** What every configured provider supports in this browser, and why not. */
	support(): ProviderSupport[];
	/** Fetch newer auth documents and refresh every provider's models. Failures are returned, not thrown. */
	refresh(options?: AuthOperationOptions): Promise<ModelsRefreshResult>;
	/**
	 * Sign in with an OAuth method (the first available one by default) in pi.dev's popup, store the
	 * credential and refresh the provider's models. Call it from a click handler.
	 */
	signIn(providerId: string, methodId?: string, options?: AuthOperationOptions): Promise<ModelsRefreshResult>;
	/** Store an API key and refresh the provider's models. */
	setApiKey(providerId: string, key: string, options?: AuthOperationOptions): Promise<ModelsRefreshResult>;
	/** Forget the provider's stored credential. */
	signOut(providerId: string, options?: AuthOperationOptions): Promise<void>;
	/** Close the database connection. */
	close(): void;
}

const DEFAULT_PI_URL = "https://pi.dev";
const DEFAULT_DATABASE = "pi-connect";
const DOCUMENTS_KEY = "auth";
const DOCUMENTS_PATH = "/api/auth/providers";

/** What the documents store keeps: the newest documents and the ETag they were fetched with. */
interface CachedDocuments {
	documents: AuthDocuments;
	etag?: string;
}

/** What `openConnect` prepared for the session. */
interface SessionParts {
	options: ConnectOptions;
	piUrl: string;
	database: ConnectDatabase;
	credentials: IndexedDbCredentialStore;
	models: MutableModels;
	cached: CachedDocuments | undefined;
}

/**
 * Open pi-connect: register pi-ai's OAuth flows for this page, open the database and restore the cached
 * auth documents and model catalogs without network access. OAuth flows are registered for the whole
 * page, so all `Connect`s of a page share one `piUrl`.
 */
export async function openConnect(options: ConnectOptions): Promise<Connect> {
	const piUrl = checkedPiUrl(options.piUrl ?? DEFAULT_PI_URL);
	const databaseName = options.database ?? DEFAULT_DATABASE;
	registerOAuthFlows({ fetch: relayFetch(piUrl) });
	const database = await ConnectDatabase.open(databaseName, options.indexedDB);
	// Only this module writes the documents store.
	const cached = (await database.get("documents", DOCUMENTS_KEY)) as CachedDocuments | undefined;
	const credentials = new IndexedDbCredentialStore(database, `pi-connect:${databaseName}`, options.locks);
	const models = createModels({ credentials, modelsStore: new IndexedDbModelsStore(database) });
	for (const provider of options.providers) {
		models.setProvider(
			options.catalogs !== false && !provider.refreshModels
				? withRemoteCatalog(provider, { baseUrl: piUrl })
				: provider,
		);
	}
	await models.refresh({ allowNetwork: false });
	return new ConnectSession({ options, piUrl, database, credentials, models, cached });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** pi.dev's origin. Refresh tokens travel there through the relay, so plain http is refused except on this machine. */
function checkedPiUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return url.origin;
	throw new TypeError(`piUrl must be an https URL (http only on localhost): ${value}`);
}

class ConnectSession implements Connect {
	readonly models: MutableModels;
	documents: AuthDocuments;
	private readonly options: ConnectOptions;
	private readonly piUrl: string;
	private readonly database: ConnectDatabase;
	private readonly credentials: IndexedDbCredentialStore;
	private etag: string | undefined;

	constructor({ options, piUrl, database, credentials, models, cached }: SessionParts) {
		this.options = options;
		this.piUrl = piUrl;
		this.database = database;
		this.credentials = credentials;
		this.models = models;
		const useCached = cached !== undefined && cached.documents.revision >= BUILTIN_AUTH_DOCUMENTS.revision;
		this.documents = useCached ? cached.documents : BUILTIN_AUTH_DOCUMENTS;
		this.etag = useCached ? cached.etag : undefined;
	}

	support(): ProviderSupport[] {
		return this.models.getProviders().map((provider) =>
			describeSupport(
				provider,
				this.documents.providers.find((document) => document.provider === provider.id),
				{ manual: this.options.manual === true },
			),
		);
	}

	async refresh(options?: AuthOperationOptions): Promise<ModelsRefreshResult> {
		let documentsError: Error | undefined;
		try {
			await this.refreshDocuments(options?.signal);
		} catch (error) {
			documentsError = error instanceof Error ? error : new Error(String(error));
		}
		const result = await this.models.refresh({ signal: options?.signal });
		if (!documentsError) return result;
		return { aborted: result.aborted, errors: new Map([...result.errors, ["auth-documents", documentsError]]) };
	}

	async signIn(providerId: string, methodId?: string, options?: AuthOperationOptions): Promise<ModelsRefreshResult> {
		const support = this.requireSupport(providerId);
		const oauth = support.methods.filter((method) => method.type === "oauth");
		const method = methodId
			? oauth.find((candidate) => candidate.id === methodId)
			: (oauth.find((candidate) => candidate.available) ?? oauth[0]);
		if (!method) {
			throw new ConnectError(
				"unavailable",
				methodId
					? `${support.name} has no OAuth sign-in "${methodId}".`
					: (support.reason ?? `${support.name} has no OAuth sign-in.`),
			);
		}
		if (!method.available) throw new ConnectError("unavailable", method.reason ?? "Not available in this browser.");
		const credential = await signInWithPopup(
			this.piUrl,
			{ provider: providerId, method: method.id, manual: this.options.manual === true },
			options?.signal,
			this.options.window,
		);
		return this.store(providerId, credential, options);
	}

	setApiKey(providerId: string, key: string, options?: AuthOperationOptions): Promise<ModelsRefreshResult> {
		this.requireSupport(providerId);
		return this.store(providerId, { type: "api_key", key }, options);
	}

	signOut(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.models.logout(providerId, options);
	}

	close(): void {
		this.database.close();
	}

	private requireSupport(providerId: string): ProviderSupport {
		const support = this.support().find((entry) => entry.provider === providerId);
		if (!support) throw new ConnectError("unknown_provider", `No provider "${providerId}" is configured.`);
		return support;
	}

	/** Replace the provider's credential, then refresh its models with it. */
	private async store(
		providerId: string,
		credential: Credential,
		options: AuthOperationOptions | undefined,
	): Promise<ModelsRefreshResult> {
		await this.credentials.modify(providerId, async () => credential, options);
		return this.models.refresh({ providers: [providerId], signal: options?.signal });
	}

	/** Fetch the documents; a newer revision replaces the current one and is cached. */
	private async refreshDocuments(signal: AbortSignal | undefined): Promise<void> {
		const response = await fetch(new URL(DOCUMENTS_PATH, this.piUrl), {
			headers: this.etag
				? { accept: "application/json", "if-none-match": this.etag }
				: { accept: "application/json" },
			signal,
		});
		if (response.status === 304) return;
		if (!response.ok) throw new Error(`Auth documents request failed: ${response.status}`);
		const documents = parseAuthDocuments(await response.json());
		if (!documents) throw new Error("pi.dev sent invalid auth documents");
		if (documents.revision < this.documents.revision) return;
		const etag = response.headers.get("etag") ?? undefined;
		await this.database.put("documents", DOCUMENTS_KEY, { documents, etag } satisfies CachedDocuments);
		this.documents = documents;
		this.etag = etag;
	}
}
