/**
 * GitHub Copilot OAuth flow
 */
import { type OAuthCredentials } from "./storage.js";
export declare function normalizeDomain(input: string): string | null;
/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * Returns API URL like https://api.individual.githubcopilot.com
 */
export declare function getBaseUrlFromToken(token: string): string | null;
export declare function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string;
/**
 * Refresh GitHub Copilot token
 */
export declare function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
): Promise<OAuthCredentials>;
/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
export declare function enableGitHubCopilotModel(
	token: string,
	modelId: string,
	enterpriseDomain?: string,
): Promise<boolean>;
/**
 * Enable all known GitHub Copilot models that may require policy acceptance.
 * Called after successful login to ensure all models are available.
 */
export declare function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain?: string,
	onProgress?: (model: string, success: boolean) => void,
): Promise<void>;
/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 */
export declare function loginGitHubCopilot(options: {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
}): Promise<OAuthCredentials>;
//# sourceMappingURL=github-copilot.d.ts.map
