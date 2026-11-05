/**
 * Sign-in route logic: login, callback, session and logout. The files in api/auth/ wire these to the real
 * environment and `fetch`.
 */
import { type AuthRequest, type AuthResponse, firstQuery } from "./http.ts";
import {
  type FetchLike,
  type OwnerAuthEnv,
  authConfigured,
  finishLogin,
  logoutCookie,
  sessionFromCookie,
  startLogin,
} from "./owner.ts";

export interface AuthDeps {
  env: OwnerAuthEnv;
  fetch: FetchLike;
}

/** GET: sends the browser to Vercel to sign in. 503 when sign-in is not configured. */
export function login(request: AuthRequest, response: AuthResponse, deps: AuthDeps): void {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const start = startLogin(deps.env);
  if (!start) {
    response.status(503).json({ error: "Sign-in is not configured" });
    return;
  }
  response.setHeader("Set-Cookie", start.setCookie);
  response.setHeader("Location", start.location);
  response.status(302).end();
}

/** GET: Vercel returns here with a code. A session is set only for an allow-listed owner. */
export async function callback(request: AuthRequest, response: AuthResponse, deps: AuthDeps): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await finishLogin(
    deps.env,
    { code: firstQuery(request.query?.code), state: firstQuery(request.query?.state), cookie: request.headers?.cookie },
    deps.fetch,
  );
  response.setHeader("Set-Cookie", result.setCookies);
  if (!result.ok) {
    // One generic outcome for the browser; the reason is not shown, so the page cannot be used to probe the allow-list.
    response.setHeader("Location", `/?signin=failed`);
    response.status(302).end();
    return;
  }
  response.setHeader("Location", "/");
  response.status(302).end();
}

/** GET: who is signed in. Never returns a secret or token. */
export function session(request: AuthRequest, response: AuthResponse, deps: AuthDeps): void {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  const configured = authConfigured(deps.env);
  const who = configured ? sessionFromCookie(deps.env, request.headers?.cookie) : undefined;
  response.status(200).json(who ? { configured, signedIn: true, name: who.name } : { configured, signedIn: false });
}

/** POST: ends the session. */
export function logout(request: AuthRequest, response: AuthResponse): void {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  response.setHeader("Set-Cookie", logoutCookie());
  response.status(200).json({ signedIn: false });
}
