/**
 * PKCE (Proof Key for Code Exchange) utilities using Web Crypto API.
 * Works in both Node.js 20+ and browsers.
 */
/**
 * Encode bytes as base64url string (RFC 4648 §5).
 * No padding, URL-safe alphabet.
 */
function base64urlEncode(bytes) {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/**
 * Generate a cryptographically random code verifier.
 * Returns a 43-character base64url string (32 random bytes).
 */
function generateVerifier() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64urlEncode(bytes);
}
/**
 * Compute the S256 code challenge from a verifier.
 * challenge = base64url(SHA-256(verifier))
 */
async function computeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return base64urlEncode(new Uint8Array(hashBuffer));
}
/**
 * Generate PKCE code verifier and challenge pair.
 * Uses Web Crypto API for cross-platform compatibility.
 */
export async function generatePKCE() {
    const verifier = generateVerifier();
    const challenge = await computeChallenge(verifier);
    return { verifier, challenge };
}
//# sourceMappingURL=pkce.js.map