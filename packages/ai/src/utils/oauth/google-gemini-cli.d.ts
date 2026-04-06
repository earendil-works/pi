/**
 * Gemini CLI OAuth flow (Google Cloud Code Assist)
 * Standard Gemini models only (gemini-2.0-flash, gemini-2.5-*)
 */
import { type OAuthCredentials } from "./storage.js";
export interface GoogleCloudCredentials extends OAuthCredentials {
    projectId: string;
    email?: string;
}
/**
 * Refresh Google Cloud Code Assist token
 */
export declare function refreshGoogleCloudToken(refreshToken: string, projectId: string): Promise<OAuthCredentials>;
/**
 * Login with Gemini CLI (Google Cloud Code Assist) OAuth
 *
 * @param onAuth - Callback with URL and optional instructions
 * @param onProgress - Optional progress callback
 */
export declare function loginGeminiCli(onAuth: (info: {
    url: string;
    instructions?: string;
}) => void, onProgress?: (message: string) => void): Promise<GoogleCloudCredentials>;
//# sourceMappingURL=google-gemini-cli.d.ts.map