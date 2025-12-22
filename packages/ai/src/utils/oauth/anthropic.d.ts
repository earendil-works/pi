/**
 * Anthropic OAuth flow (Claude Pro/Max)
 */
import { type OAuthCredentials } from "./storage.js";
/**
 * Login with Anthropic OAuth (device code flow)
 *
 * @param onAuthUrl - Callback to handle the authorization URL (e.g., open browser)
 * @param onPromptCode - Callback to prompt user for the authorization code
 */
export declare function loginAnthropic(
	onAuthUrl: (url: string) => void,
	onPromptCode: () => Promise<string>,
): Promise<void>;
/**
 * Refresh Anthropic OAuth token
 */
export declare function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials>;
//# sourceMappingURL=anthropic.d.ts.map
