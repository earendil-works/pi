// What works in this browser: auth documents applied to the providers an app configured.

import type { Provider } from "@earendil-works/pi-ai";
import { type AuthDocument, type AuthMethodDocument, type BrowserTier, browserTier } from "./documents.ts";

export interface MethodSupport {
	id: string;
	type: "api_key" | "oauth";
	label: string;
	/** `unknown` when pi.dev has no document for the provider. */
	tier: BrowserTier | "unknown";
	/** Whether the app can use the method in this browser. */
	available: boolean;
	/** Why the method is unavailable, or what an available one involves (the relay, pasting). */
	reason?: string;
}

export interface ProviderSupport {
	provider: string;
	name: string;
	/** Whether a browser can call the provider's model API; `unknown` without a document. */
	inference: "direct" | "unsupported" | "unknown";
	/** Whether at least one method is available. */
	available: boolean;
	/** Why the provider is unavailable, or that pi.dev has no information about it. */
	reason?: string;
	methods: MethodSupport[];
}

export interface SupportOptions {
	/** Offer methods that end with pasting the address of a page that fails to load. */
	manual: boolean;
}

const NO_DOCUMENT = "pi.dev has no browser information for this provider; whether it works is untested.";

/** Describe what a provider supports in a browser, from its auth document when pi.dev has one. */
export function describeSupport(
	provider: Provider,
	document: AuthDocument | undefined,
	options: SupportOptions,
): ProviderSupport {
	if (!document) return describeUndocumented(provider);
	const inference = document.inference;
	const methods = document.methods.map((method) => describeMethod(provider, document, method, options));
	const available = methods.some((method) => method.available);
	return {
		provider: provider.id,
		name: document.name,
		inference: inference.browser,
		available,
		reason:
			inference.browser === "unsupported"
				? inference.reason
				: available
					? undefined
					: "No sign-in method of this provider works in this browser.",
		methods,
	};
}

function describeMethod(
	provider: Provider,
	document: AuthDocument,
	method: AuthMethodDocument,
	options: SupportOptions,
): MethodSupport {
	const unavailable = unavailableReason(provider, document, method, options);
	return {
		id: method.id,
		type: method.type,
		label: method.label,
		tier: browserTier(method.browser),
		available: unavailable === undefined,
		reason: unavailable ?? method.browser.reason,
	};
}

function unavailableReason(
	provider: Provider,
	document: AuthDocument,
	method: AuthMethodDocument,
	options: SupportOptions,
): string | undefined {
	if (!(method.type === "api_key" ? provider.auth.apiKey : provider.auth.oauth)) {
		return `This app's ${provider.name} provider has no ${method.type === "api_key" ? "API key" : "OAuth"} sign-in.`;
	}
	return browserRefusal(document, method, options);
}

/** Why a documented method cannot be used in a browser with these options, or undefined when it can. */
export function browserRefusal(
	document: AuthDocument,
	method: AuthMethodDocument,
	options: SupportOptions,
): string | undefined {
	if (document.inference.browser === "unsupported") {
		return document.inference.reason ?? "The provider's model API does not accept browser requests.";
	}
	if (method.browser.signIn === "unsupported") return method.browser.reason ?? "Not possible in a browser.";
	if (method.browser.signIn === "manual" && !options.manual) {
		return `${method.browser.reason ?? "This sign-in ends with pasting an address."} The app has not enabled such sign-ins.`;
	}
	return undefined;
}

function describeUndocumented(provider: Provider): ProviderSupport {
	const apiKey = provider.auth.apiKey;
	const methods: MethodSupport[] = apiKey
		? [{ id: "api_key", type: "api_key", label: apiKey.name, tier: "unknown", available: true, reason: NO_DOCUMENT }]
		: [];
	return {
		provider: provider.id,
		name: provider.name,
		inference: "unknown",
		available: methods.length > 0,
		reason: NO_DOCUMENT,
		methods,
	};
}
