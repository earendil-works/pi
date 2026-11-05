/**
 * Owner sign-in with Vercel (OAuth 2.0 authorization code with PKCE).
 *
 * Only Vercel users whose id (`sub`) is in the owner-set allow-list `NLT_OWNER_VERCEL_SUBS` get a session.
 * An empty or missing allow-list admits nobody. Nothing here grants authority to a model; it only says
 * which human may call the agent route. The Vercel Authentication wall in front of the project stays in
 * place; this is a second, application-level check.
 *
 * Endpoints are from the Sign in with Vercel documentation: authorize at vercel.com/oauth/authorize, token and
 * userinfo under api.vercel.com/login/oauth. Not exercised against the live service by the offline tests.
 */
import { createHash, randomBytes } from "node:crypto";
import { cookieHeader, readCookie, signToken, secretUsable, verifyToken } from "./session.ts";

export const SESSION_COOKIE = "nlt_session";
export const OAUTH_COOKIE = "nlt_oauth";
const SESSION_SECONDS = 8 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;
const AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
const TOKEN_URL = "https://api.vercel.com/login/oauth/token";
const USERINFO_URL = "https://api.vercel.com/login/oauth/userinfo";

export interface OwnerAuthEnv {
  VERCEL_APP_CLIENT_ID?: string;
  VERCEL_APP_CLIENT_SECRET?: string;
  /** Exact redirect URI registered on the Vercel app, for example https://host/api/auth/callback. */
  VERCEL_APP_REDIRECT_URI?: string;
  NLT_SESSION_SECRET?: string;
  /** Comma-separated Vercel user ids (`sub`) or usernames allowed to sign in. An id is stable; a username can change. */
  NLT_OWNER_VERCEL_SUBS?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  /** HTTP status, used only in the server-side failure detail. */
  status?: number;
  json(): Promise<unknown>;
}>;

export interface Session {
  sub: string;
  name: string;
}

/** True when every setting needed to sign in is present. */
export function authConfigured(env: OwnerAuthEnv): boolean {
  return Boolean(
    env.VERCEL_APP_CLIENT_ID &&
      env.VERCEL_APP_CLIENT_SECRET &&
      env.VERCEL_APP_REDIRECT_URI &&
      secretUsable(env.NLT_SESSION_SECRET) &&
      allowedSubs(env).size > 0,
  );
}

function allowedSubs(env: OwnerAuthEnv): Set<string> {
  return new Set((env.NLT_OWNER_VERCEL_SUBS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

/** The signed-in owner for a Cookie header, or undefined. Re-checks the allow-list on every call. */
export function sessionFromCookie(env: OwnerAuthEnv, cookieHeaderValue: string | string[] | undefined): Session | undefined {
  const payload = verifyToken(env.NLT_SESSION_SECRET, readCookie(cookieHeaderValue, SESSION_COOKIE));
  if (!payload || typeof payload.sub !== "string") return undefined;
  const allowed = allowedSubs(env);
  const username = typeof payload.username === "string" ? payload.username : undefined;
  if (!allowed.has(payload.sub) && !(username !== undefined && allowed.has(username))) return undefined;
  return { sub: payload.sub, name: typeof payload.name === "string" ? payload.name : payload.sub };
}

export interface LoginStart {
  location: string;
  setCookie: string;
}

/** Starts sign-in: a fresh state and PKCE verifier, kept in a signed 10-minute cookie, and the Vercel URL to go to. */
export function startLogin(env: OwnerAuthEnv, now = Math.floor(Date.now() / 1000)): LoginStart | undefined {
  if (!authConfigured(env)) return undefined;
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: env.VERCEL_APP_CLIENT_ID as string,
    redirect_uri: env.VERCEL_APP_REDIRECT_URI as string,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_type: "code",
    scope: "openid email profile",
  });
  const token = signToken(env.NLT_SESSION_SECRET, { exp: now + OAUTH_SECONDS, state, verifier });
  return { location: `${AUTHORIZE_URL}?${query.toString()}`, setCookie: cookieHeader(OAUTH_COOKIE, token, OAUTH_SECONDS) };
}

export type CallbackResult =
  | { ok: true; setCookies: string[] }
  | {
      ok: false;
      reason: "not_configured" | "bad_request" | "exchange_failed" | "not_allowed";
      /**
       * Which check failed, for the server log only; never sent to the browser. Holds no token, code, secret or
       * cookie: only OAuth error codes, HTTP statuses, and for `not_allowed` the Vercel id and username that were
       * refused, so the owner can see what to put on the allow-list.
       */
      detail: string;
      setCookies: string[];
    };

/** Keeps a value from an outside party to a short run of safe characters before it goes into a log line. */
function safe(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "none";
  const text = String(value).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
  return text === "" ? "none" : text;
}

/** Finishes sign-in. Checks state, exchanges the code, reads the user, and admits only allow-listed ids. */
export async function finishLogin(
  env: OwnerAuthEnv,
  input: { code?: string; state?: string; error?: string; cookie: string | string[] | undefined },
  fetchImpl: FetchLike,
  now = Math.floor(Date.now() / 1000),
): Promise<CallbackResult> {
  const clear = [cookieHeader(OAUTH_COOKIE, "", 0)];
  const fail = (reason: Extract<CallbackResult, { ok: false }>["reason"], detail: string): CallbackResult => ({
    ok: false,
    reason,
    detail,
    setCookies: clear,
  });
  if (!authConfigured(env)) return fail("not_configured", "missing_setting");
  if (input.error !== undefined) return fail("bad_request", `vercel_error=${safe(input.error)}`);
  const saved = verifyToken(env.NLT_SESSION_SECRET, readCookie(input.cookie, OAUTH_COOKIE), now);
  if (!saved || typeof saved.state !== "string" || typeof saved.verifier !== "string") {
    return fail("bad_request", "state_cookie_missing_or_expired");
  }
  if (!input.code) return fail("bad_request", "code_missing");
  if (!input.state || input.state !== saved.state) return fail("bad_request", "state_mismatch");

  let accessToken: string;
  try {
    const tokenResponse = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.VERCEL_APP_CLIENT_ID as string,
        client_secret: env.VERCEL_APP_CLIENT_SECRET as string,
        code: input.code,
        code_verifier: saved.verifier,
        redirect_uri: env.VERCEL_APP_REDIRECT_URI as string,
      }).toString(),
    });
    const tokens = (await tokenResponse.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
    if (!tokenResponse.ok || typeof tokens.access_token !== "string") {
      return fail("exchange_failed", `token status=${safe(tokenResponse.status)} error=${safe(tokens.error)}`);
    }
    accessToken = tokens.access_token;
  } catch (error) {
    return fail("exchange_failed", `token threw=${safe(error instanceof Error ? error.name : undefined)}`);
  }

  let sub: string;
  let name: string;
  let username: string | undefined;
  try {
    const infoResponse = await fetchImpl(USERINFO_URL, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
    const info = (await infoResponse.json().catch(() => ({}))) as { sub?: unknown; name?: unknown; preferred_username?: unknown; error?: unknown };
    username = typeof info.preferred_username === "string" ? info.preferred_username : undefined;
    if (!infoResponse.ok || typeof info.sub !== "string") {
      return fail("exchange_failed", `userinfo status=${safe(infoResponse.status)} error=${safe(info.error)} sub=${typeof info.sub}`);
    }
    sub = info.sub;
    name = typeof info.name === "string" ? info.name : typeof info.preferred_username === "string" ? info.preferred_username : info.sub;
  } catch (error) {
    return fail("exchange_failed", `userinfo threw=${safe(error instanceof Error ? error.name : undefined)}`);
  }

  const allowed = allowedSubs(env);
  if (!allowed.has(sub) && !(username !== undefined && allowed.has(username))) {
    return fail("not_allowed", `sub=${safe(sub)} username=${safe(username)}`);
  }
  const session = signToken(env.NLT_SESSION_SECRET, { exp: now + SESSION_SECONDS, sub, username, name: name.slice(0, 80) });
  return { ok: true, setCookies: [...clear, cookieHeader(SESSION_COOKIE, session, SESSION_SECONDS)] };
}

/** Set-Cookie value that ends the session. */
export function logoutCookie(): string {
  return cookieHeader(SESSION_COOKIE, "", 0);
}
