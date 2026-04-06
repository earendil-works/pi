/**
 * Antigravity OAuth flow (Gemini 3, Claude, GPT-OSS via Google Cloud)
 * Uses different OAuth credentials than google-gemini-cli for access to additional models.
 */
import { type OAuthCredentials } from "./storage.js";
export interface AntigravityCredentials extends OAuthCredentials {
    projectId: string;
    email?: string;
}
/**
 * Refresh Antigravity token
 */
export declare function refreshAntigravityToken(refreshToken: string, projectId: string): Promise<OAuthCredentials>;
/**
 * Login with Antigravity OAuth
 *
 * @param onAuth - Callback with URL and optional instructions
 * @param onProgress - Optional progress callback
 */
export declare function loginAntigravity(onAuth: (info: {
    url: string;
    instructions?: string;
}) => void, onProgress?: (message: string) => void): Promise<AntigravityCredentials>;
//# sourceMappingURL=google-antigravity.d.ts.map