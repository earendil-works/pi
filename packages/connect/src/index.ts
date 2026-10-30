// pi-connect: sign in to model providers from the browser, with what works and why published by pi.dev.

export { BUILTIN_AUTH_DOCUMENTS } from "./builtin-documents.ts";
export { type Connect, type ConnectOptions, openConnect } from "./connect.ts";
export { IndexedDbCredentialStore } from "./credential-store.ts";
export { ConnectDatabase } from "./database.ts";
export {
	type AuthDocument,
	type AuthDocuments,
	type AuthMethodDocument,
	type AuthMethodKind,
	type BrowserSupport,
	type BrowserTier,
	browserTier,
	parseAuthDocuments,
} from "./documents.ts";
export { ConnectError, type ConnectErrorCode } from "./errors.ts";
export { IndexedDbModelsStore } from "./models-store.ts";
export { type PopupHost, type PopupSignIn, signInWithPopup } from "./popup.ts";
export {
	findRelayEndpoint,
	RELAY_ENDPOINTS,
	RELAY_PATH,
	type RelayAccess,
	type RelayEndpoint,
	relayFetch,
} from "./relay.ts";
export {
	browserRefusal,
	describeSupport,
	type MethodSupport,
	type ProviderSupport,
	type SupportOptions,
} from "./support.ts";
