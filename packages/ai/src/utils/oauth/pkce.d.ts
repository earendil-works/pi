/**
 * PKCE (Proof Key for Code Exchange) utilities using Web Crypto API.
 * Works in both Node.js 20+ and browsers.
 */
/**
 * Generate PKCE code verifier and challenge pair.
 * Uses Web Crypto API for cross-platform compatibility.
 */
export declare function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}>;
//# sourceMappingURL=pkce.d.ts.map
