import type { OAuthClientProvider } from "./flow.ts";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthDiscoveryState, OAuthTokens } from "./types.ts";

export interface McpOAuthState {
	serverUrl: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	oauthState?: string;
	discovery?: OAuthDiscoveryState;
}

export interface McpOAuthStateStore {
	load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
	save(state: McpOAuthState): void | Promise<void>;
}

export interface McpOAuthProviderOptions {
	serverUrl: string | URL;
	redirectUrl: string | URL;
	clientMetadata: Omit<OAuthClientMetadata, "redirect_uris"> & { redirect_uris?: string[] };
	clientId?: string;
	clientSecret?: string;
	store?: McpOAuthStateStore;
	onRedirect(url: URL): void | Promise<void>;
}

export class MemoryOAuthStateStore implements McpOAuthStateStore {
	private value: McpOAuthState | undefined;

	load(): McpOAuthState | undefined {
		return this.value === undefined ? undefined : structuredClone(this.value);
	}

	save(state: McpOAuthState): void {
		this.value = structuredClone(state);
	}
}

/** Default stateful provider for one exact MCP server URL. Applications inject durable storage if needed. */
export class McpOAuthProvider implements OAuthClientProvider {
	readonly redirectUrl: string;
	readonly clientMetadata: OAuthClientMetadata;
	private serverUrl: string;
	private configuredClient: OAuthClientInformationMixed | undefined;
	private store: McpOAuthStateStore;
	private onRedirect: (url: URL) => void | Promise<void>;
	private writes: Promise<void> = Promise.resolve();

	constructor(options: McpOAuthProviderOptions) {
		this.serverUrl = String(new URL(options.serverUrl));
		this.redirectUrl = String(options.redirectUrl);
		this.clientMetadata = {
			...options.clientMetadata,
			redirect_uris: options.clientMetadata.redirect_uris ?? [this.redirectUrl],
			grant_types: options.clientMetadata.grant_types ?? ["authorization_code", "refresh_token"],
			response_types: options.clientMetadata.response_types ?? ["code"],
			token_endpoint_auth_method:
				options.clientMetadata.token_endpoint_auth_method ?? (options.clientSecret ? "client_secret_post" : "none"),
		};
		this.configuredClient = options.clientId
			? { client_id: options.clientId, ...(options.clientSecret ? { client_secret: options.clientSecret } : {}) }
			: undefined;
		this.store = options.store ?? new MemoryOAuthStateStore();
		this.onRedirect = options.onRedirect;
	}

	async state(): Promise<string> {
		const existing = (await this.load()).oauthState;
		if (existing) return existing;
		const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		await this.update((value) => ({ ...value, oauthState: state }));
		return state;
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return this.configuredClient ?? (await this.load()).clientInformation;
	}

	async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
		if (this.configuredClient) return;
		await this.update((value) => ({ ...value, clientInformation: information }));
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		return (await this.load()).tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.update((value) => ({ ...value, tokens }));
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		await this.onRedirect(url);
	}

	async saveCodeVerifier(verifier: string): Promise<void> {
		await this.update((value) => ({ ...value, codeVerifier: verifier }));
	}

	async codeVerifier(): Promise<string> {
		const verifier = (await this.load()).codeVerifier;
		if (!verifier) throw new Error("No OAuth PKCE code verifier is stored");
		return verifier;
	}

	async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		await this.update((value) => {
			const next = { ...value };
			if (kind === "all" || kind === "client") delete next.clientInformation;
			if (kind === "all" || kind === "tokens") delete next.tokens;
			if (kind === "all" || kind === "verifier") delete next.codeVerifier;
			if (kind === "all" || kind === "discovery") delete next.discovery;
			if (kind === "all") delete next.oauthState;
			return next;
		});
	}

	async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
		await this.update((value) => ({ ...value, discovery }));
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return (await this.load()).discovery;
	}

	private async load(): Promise<McpOAuthState> {
		await this.writes;
		return this.own(await this.store.load());
	}

	private async update(update: (state: McpOAuthState) => McpOAuthState): Promise<void> {
		this.writes = this.writes.then(async () => {
			await this.store.save(update(this.own(await this.store.load())));
		});
		await this.writes;
	}

	/** Stored state for another server URL is ignored so credentials never leak across servers. */
	private own(state: McpOAuthState | undefined): McpOAuthState {
		return state?.serverUrl === this.serverUrl ? state : { serverUrl: this.serverUrl };
	}
}
