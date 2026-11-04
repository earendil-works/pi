export { createMcpAuthProvider, type McpAuthProvider } from "./auth-provider.ts";
export {
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthCallbackServerOptions,
} from "./callback.ts";
export type {
	McpClientMetadataDocuments,
	McpOAuthClientOptions,
	McpOAuthServerStore,
	McpOAuthSettings,
} from "./client-settings.ts";
export {
	buildAuthorizationServerDiscoveryUrls,
	discoverAuthorizationServerMetadata,
	discoverOAuthServerInfo,
	discoverProtectedResourceMetadata,
	parseWwwAuthenticate,
	resourceUrlFromServerUrl,
	selectResource,
} from "./discovery.ts";
export {
	McpOAuthAuthorizationRequiredError,
	McpRefreshLockBusyError,
	OAuthError,
	OAuthInsecureEndpointError,
	OAuthIssuerMismatchError,
	OAuthRegistrationError,
} from "./errors.ts";
export {
	type AddClientAuthentication,
	adaptOAuthProvider,
	authorizeMcp,
	exchangeAuthorizationCode,
	type OAuthClientMetadataDocument,
	type OAuthClientProvider,
	type OAuthFlowOptions,
	type OAuthFlowResult,
	refreshAuthorization,
	registerClient,
	startAuthorization,
	stepUpScope,
	type TokenRequestOptions,
} from "./flow.ts";
export {
	listenForLoopbackSignIn,
	type McpLoopbackCallback,
	responseFromRedirectUrl,
	waitForLoopbackSignIn,
} from "./loopback.ts";
export {
	McpOAuthProvider,
	type McpOAuthProviderOptions,
	type McpOAuthState,
	type McpOAuthStateStore,
	MemoryOAuthStateStore,
} from "./provider.ts";
export {
	completeMcpSignIn,
	type McpAuthorizationResponse,
	McpSignInCancelledError,
	type McpSignInOptions,
	type McpSignInRedirect,
	type McpSignInStart,
	startMcpSignIn,
} from "./sign-in.ts";
export type {
	AuthorizationServerMetadata,
	OAuthChallenge,
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthDiscoveryState,
	OAuthProtectedResourceMetadata,
	OAuthServerInfo,
	OAuthTokens,
} from "./types.ts";
