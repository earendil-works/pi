/**
 * OpenAI Codex (ChatGPT OAuth) flow.
 * Enables using ChatGPT Plus/Pro subscription for API access.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { generatePKCE } from "./pkce.js";
import { addOAuthAccount } from "./storage.js";
// ============================================================================
// Constants
// ============================================================================
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #131010; color: #f1ecec; }
    .container { text-align: center; padding: 2rem; }
    h1 { margin-bottom: 1rem; }
    p { color: #b7b1b1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to your terminal.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000)</script>
</body>
</html>`;
// ============================================================================
// Helpers
// ============================================================================
function createState() {
    return randomBytes(16).toString("hex");
}
function parseAuthorizationInput(input) {
    const value = input.trim();
    if (!value)
        return {};
    // Try parsing as URL
    try {
        const url = new URL(value);
        return {
            code: url.searchParams.get("code") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
        };
    }
    catch {
        // Not a URL
    }
    // Try code#state format
    if (value.includes("#")) {
        const [code, state] = value.split("#", 2);
        return { code, state };
    }
    // Try query string format
    if (value.includes("code=")) {
        const params = new URLSearchParams(value);
        return {
            code: params.get("code") ?? undefined,
            state: params.get("state") ?? undefined,
        };
    }
    // Assume raw code
    return { code: value };
}
function decodeJwt(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return null;
        const payload = parts[1] ?? "";
        const decoded = Buffer.from(payload, "base64").toString("utf-8");
        return JSON.parse(decoded);
    }
    catch {
        return null;
    }
}
function getAccountId(accessToken) {
    const payload = decodeJwt(accessToken);
    const auth = payload?.[JWT_CLAIM_PATH];
    const accountId = auth?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}
function getEmail(token) {
    const payload = decodeJwt(token);
    const email = payload?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
}
// ============================================================================
// Token Exchange
// ============================================================================
async function exchangeAuthorizationCode(code, verifier, redirectUri = REDIRECT_URI) {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
        }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error("[openai-codex] code->token failed:", response.status, text);
        return { type: "failed" };
    }
    const json = (await response.json());
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
        console.error("[openai-codex] token response missing fields:", json);
        return { type: "failed" };
    }
    const idToken = typeof json.id_token === "string" ? json.id_token : undefined;
    return {
        type: "success",
        access: json.access_token,
        refresh: json.refresh_token,
        expires: Date.now() + json.expires_in * 1000,
        idToken,
    };
}
async function refreshAccessToken(refreshToken) {
    try {
        const response = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            }),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            console.error("[openai-codex] Token refresh failed:", response.status, text);
            return { type: "failed" };
        }
        const json = (await response.json());
        if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
            console.error("[openai-codex] Token refresh response missing fields:", json);
            return { type: "failed" };
        }
        return {
            type: "success",
            access: json.access_token,
            refresh: json.refresh_token,
            expires: Date.now() + json.expires_in * 1000,
        };
    }
    catch (error) {
        console.error("[openai-codex] Token refresh error:", error);
        return { type: "failed" };
    }
}
// ============================================================================
// Authorization Flow
// ============================================================================
async function createAuthorizationFlow() {
    const { verifier, challenge } = await generatePKCE();
    const state = createState();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "mu");
    return { verifier, state, url: url.toString() };
}
function startLocalOAuthServer(state) {
    let lastCode = null;
    let cancelled = false;
    const server = http.createServer((req, res) => {
        try {
            const url = new URL(req.url || "", "http://localhost");
            if (url.pathname !== "/auth/callback") {
                res.statusCode = 404;
                res.end("Not found");
                return;
            }
            if (url.searchParams.get("state") !== state) {
                res.statusCode = 400;
                res.end("State mismatch");
                return;
            }
            const code = url.searchParams.get("code");
            if (!code) {
                res.statusCode = 400;
                res.end("Missing authorization code");
                return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(SUCCESS_HTML);
            lastCode = code;
        }
        catch {
            res.statusCode = 500;
            res.end("Internal error");
        }
    });
    return new Promise((resolve) => {
        server
            .listen(1455, "127.0.0.1", () => {
            resolve({
                close: () => server.close(),
                cancelWait: () => {
                    cancelled = true;
                },
                waitForCode: async () => {
                    const sleep = () => new Promise((r) => setTimeout(r, 100));
                    for (let i = 0; i < 600; i++) {
                        if (lastCode)
                            return { code: lastCode };
                        if (cancelled)
                            return null;
                        await sleep();
                    }
                    return null;
                },
            });
        })
            .on("error", (err) => {
            console.error("[openai-codex] Failed to bind http://127.0.0.1:1455 (", err.code, ") Falling back to manual paste.");
            resolve({
                close: () => {
                    try {
                        server.close();
                    }
                    catch {
                        // ignore
                    }
                },
                cancelWait: () => { },
                waitForCode: async () => null,
            });
        });
    });
}
// ============================================================================
// Public API
// ============================================================================
/**
 * Login with OpenAI Codex OAuth.
 *
 * @param options.onAuth - Called with URL and instructions when auth starts
 * @param options.onPrompt - Called to prompt user for manual code paste (fallback)
 * @param options.onProgress - Optional progress messages
 * @param options.onManualCodeInput - Optional promise that resolves with user-pasted code.
 *                                    Races with browser callback - whichever completes first wins.
 */
export async function loginOpenAICodex(options) {
    const { verifier, state, url } = await createAuthorizationFlow();
    const server = await startLocalOAuthServer(state);
    options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });
    let code;
    try {
        if (options.onManualCodeInput) {
            // Race between browser callback and manual input
            let manualCode;
            let manualError;
            const manualPromise = options
                .onManualCodeInput()
                .then((input) => {
                manualCode = input;
                server.cancelWait();
            })
                .catch((err) => {
                manualError = err instanceof Error ? err : new Error(String(err));
                server.cancelWait();
            });
            const result = await server.waitForCode();
            if (manualError) {
                throw manualError;
            }
            if (result?.code) {
                code = result.code;
            }
            else if (manualCode) {
                const parsed = parseAuthorizationInput(manualCode);
                if (parsed.state && parsed.state !== state) {
                    throw new Error("State mismatch");
                }
                code = parsed.code;
            }
            if (!code) {
                await manualPromise;
                if (manualError) {
                    throw manualError;
                }
                if (manualCode) {
                    const parsed = parseAuthorizationInput(manualCode);
                    if (parsed.state && parsed.state !== state) {
                        throw new Error("State mismatch");
                    }
                    code = parsed.code;
                }
            }
        }
        else {
            const result = await server.waitForCode();
            if (result?.code) {
                code = result.code;
            }
        }
        // Fallback to onPrompt if still no code
        if (!code) {
            const input = await options.onPrompt({
                message: "Paste the authorization code (or full redirect URL):",
            });
            const parsed = parseAuthorizationInput(input);
            if (parsed.state && parsed.state !== state) {
                throw new Error("State mismatch");
            }
            code = parsed.code;
        }
        if (!code) {
            throw new Error("Missing authorization code");
        }
        const tokenResult = await exchangeAuthorizationCode(code, verifier);
        if (tokenResult.type !== "success") {
            throw new Error("Token exchange failed");
        }
        const accountId = getAccountId(tokenResult.access);
        if (!accountId) {
            throw new Error("Failed to extract accountId from token");
        }
        const email = tokenResult.idToken ? getEmail(tokenResult.idToken) : null;
        const credentials = {
            type: "oauth",
            access: tokenResult.access,
            refresh: tokenResult.refresh,
            expires: tokenResult.expires,
            accountId,
            ...(email ? { email } : {}),
        };
        const label = email ?? accountId;
        addOAuthAccount("openai-codex", credentials, label);
    }
    finally {
        server.close();
    }
}
/**
 * Refresh OpenAI Codex OAuth token.
 */
export async function refreshOpenAICodexToken(refreshToken) {
    const result = await refreshAccessToken(refreshToken);
    if (result.type !== "success") {
        throw new Error("Failed to refresh OpenAI Codex token");
    }
    const accountId = getAccountId(result.access);
    if (!accountId) {
        throw new Error("Failed to extract accountId from token");
    }
    return {
        type: "oauth",
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
        accountId,
    };
}
//# sourceMappingURL=openai-codex.js.map