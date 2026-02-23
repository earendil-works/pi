/**
 * OpenAI Codex (ChatGPT OAuth) flow.
 * Enables using ChatGPT Plus/Pro subscription for API access.
 */
import { type OAuthCredentials } from "./storage.js";
export type OAuthPrompt = {
    message: string;
    placeholder?: string;
};
/**
 * Login with OpenAI Codex OAuth.
 *
 * @param options.onAuth - Called with URL and instructions when auth starts
 * @param options.onPrompt - Called to prompt user for manual code paste (fallback)
 * @param options.onProgress - Optional progress messages
 * @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.
 *                                    Races with browser callback - whichever completes first wins.
 */
export declare function loginOpenAICodex(options: {
    onAuth: (info: {
        url: string;
        instructions?: string;
    }) => void;
    onPrompt: (prompt: OAuthPrompt) => Promise<string>;
    onProgress?: (message: string) => void;
    onManualCodeInput?: () => Promise<string>;
}): Promise<void>;
/**
 * Refresh OpenAI Codex OAuth token.
 */
export declare function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials>;
//# sourceMappingURL=openai-codex.d.ts.map