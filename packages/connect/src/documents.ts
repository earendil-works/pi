// Auth documents: what pi.dev publishes about each provider's sign-in methods in browsers.

/**
 * Documents carry metadata only. They say which methods work in a browser and why, never where a
 * request goes: endpoints and client IDs stay in pi-ai's flow code, so a document cannot send a
 * credential anywhere new. Outside browsers every method works directly, so documents describe
 * browsers alone.
 */
export interface AuthDocuments {
	version: 1;
	/** Sortable revision, e.g. "2026-07-14.1"; newer documents replace older ones. */
	revision: string;
	providers: AuthDocument[];
}

export interface AuthDocument {
	/** pi-ai provider ID. */
	provider: string;
	name: string;
	/** Whether a browser can call the provider's model API. Without it no method helps. */
	inference: { browser: "direct" | "unsupported"; reason?: string };
	methods: AuthMethodDocument[];
}

/** How a method signs in. */
export type AuthMethodKind = "api_key" | "device_code" | "pkce_copy_code" | "pkce_loopback" | "pkce_web";

export interface AuthMethodDocument {
	/**
	 * For OAuth, the option ID the provider's pi-ai flow offers in its method selection ("copy_code",
	 * "device-code"); flows with a single method ignore it.
	 */
	id: string;
	type: "api_key" | "oauth";
	kind: AuthMethodKind;
	label: string;
	browser: BrowserSupport;
}

export interface BrowserSupport {
	/**
	 * `direct`: completes in the browser. `manual`: the provider redirects to a local server, so the
	 * user pastes the address of the page that fails to load. `unsupported`: not possible.
	 */
	signIn: "direct" | "manual" | "unsupported";
	/**
	 * Which requests go through pi.dev's relay because the provider's endpoints send no CORS headers:
	 * none, the sign-in only, or the sign-in and every token refresh.
	 */
	relay: "none" | "login" | "always";
	/** Why the method is not plain `direct`; shown to users. */
	reason?: string;
}

/** A method's support in one word, as the documentation names it. */
export type BrowserTier = "direct" | "relay-login" | "relay-always" | "manual" | "unsupported";

/** Name the tier of a method's browser support. */
export function browserTier(support: BrowserSupport): BrowserTier {
	if (support.signIn !== "direct") return support.signIn;
	if (support.relay === "none") return "direct";
	return support.relay === "login" ? "relay-login" : "relay-always";
}

/** Parse auth documents received from pi.dev, or undefined when they are not valid (wire input). */
export function parseAuthDocuments(value: unknown): AuthDocuments | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.revision !== "string") return undefined;
	if (!Array.isArray(value.providers) || !value.providers.every(isAuthDocument)) return undefined;
	return { version: 1, revision: value.revision, providers: value.providers };
}

function isAuthDocument(value: unknown): value is AuthDocument {
	return (
		isRecord(value) &&
		typeof value.provider === "string" &&
		typeof value.name === "string" &&
		isRecord(value.inference) &&
		(value.inference.browser === "direct" || value.inference.browser === "unsupported") &&
		isOptionalString(value.inference.reason) &&
		Array.isArray(value.methods) &&
		value.methods.every(isAuthMethodDocument)
	);
}

const METHOD_KINDS: readonly unknown[] = ["api_key", "device_code", "pkce_copy_code", "pkce_loopback", "pkce_web"];

function isAuthMethodDocument(value: unknown): value is AuthMethodDocument {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		(value.type === "api_key" || value.type === "oauth") &&
		METHOD_KINDS.includes(value.kind) &&
		typeof value.label === "string" &&
		isRecord(value.browser) &&
		["direct", "manual", "unsupported"].includes(value.browser.signIn as string) &&
		["none", "login", "always"].includes(value.browser.relay as string) &&
		isOptionalString(value.browser.reason)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}
