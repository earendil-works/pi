import { describe, expect, it } from "vitest";
import { callback, login, logout, session } from "../src/auth/handlers.ts";
import type { AuthRequest, AuthResponse } from "../src/auth/http.ts";
import { OAUTH_COOKIE, SESSION_COOKIE, type FetchLike, type OwnerAuthEnv, authConfigured, sessionFromCookie } from "../src/auth/owner.ts";
import { readCookie, signToken, verifyToken } from "../src/auth/session.ts";

const SECRET = "s".repeat(40);
const env: OwnerAuthEnv = {
  VERCEL_APP_CLIENT_ID: "cid",
  VERCEL_APP_CLIENT_SECRET: "csecret",
  VERCEL_APP_REDIRECT_URI: "https://app.example/api/auth/callback",
  NLT_SESSION_SECRET: SECRET,
  NLT_OWNER_VERCEL_SUBS: "owner-1, owner-2",
};

function capture() {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, string | string[]> };
  const response: AuthResponse = {
    setHeader(name, value) {
      out.headers[name] = value;
    },
    status(code) {
      out.status = code;
      return {
        json(body) {
          out.body = body;
        },
        end() {},
      };
    },
  };
  return { out, response };
}

const cookiePair = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie.at(-1) : setCookie).split(";")[0] as string;

/** Runs login, then returns the state and the cookie the browser would send back. */
function startFlow(e: OwnerAuthEnv) {
  const { out, response } = capture();
  login({ method: "GET" }, response, { env: e, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  const location = new URL(String(out.headers.Location));
  return { out, state: location.searchParams.get("state") as string, location, cookie: cookiePair(out.headers["Set-Cookie"]) };
}

function fakeVercel(sub: string, options: { tokenOk?: boolean; infoOk?: boolean; username?: string } = {}) {
  const calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (url.endsWith("/token")) return { ok: options.tokenOk ?? true, json: async () => ({ access_token: "at-123" }) };
    return { ok: options.infoOk ?? true, json: async () => ({ sub, name: "Owner Name", preferred_username: options.username }) };
  };
  return { fetchImpl, calls };
}

describe("signed tokens", () => {
  it("round-trips, and rejects tampering, expiry, wrong secret and short secrets", () => {
    const token = signToken(SECRET, { exp: 2000, a: 1 });
    expect(verifyToken(SECRET, token, 1000)?.a).toBe(1);
    expect(verifyToken(SECRET, token, 2000)).toBeUndefined();
    expect(verifyToken("x".repeat(40), token, 1000)).toBeUndefined();
    const [body, sig] = token.split(".") as [string, string];
    const forged = `${Buffer.from(JSON.stringify({ exp: 9_999_999_999, a: 2 })).toString("base64url")}.${sig}`;
    expect(verifyToken(SECRET, forged, 1000)).toBeUndefined();
    expect(verifyToken(SECRET, `${body}.`, 1000)).toBeUndefined();
    for (const bad of [undefined, "", "abc", "a.b.c"]) expect(verifyToken(SECRET, bad, 1000)).toBeUndefined();
    expect(() => signToken("short", { exp: 5 })).toThrow();
    expect(verifyToken("short", token, 1000)).toBeUndefined();
  });

  it("reads one cookie by exact name", () => {
    expect(readCookie("a=1; nlt_session=abc; b=2", "nlt_session")).toBe("abc");
    expect(readCookie("xnlt_session=abc", "nlt_session")).toBeUndefined();
    expect(readCookie(undefined, "a")).toBeUndefined();
  });
});

describe("configuration", () => {
  it("needs every setting, a long secret and a non-empty allow-list", () => {
    expect(authConfigured(env)).toBe(true);
    for (const key of Object.keys(env) as (keyof OwnerAuthEnv)[]) expect(authConfigured({ ...env, [key]: undefined })).toBe(false);
    expect(authConfigured({ ...env, NLT_SESSION_SECRET: "short" })).toBe(false);
    expect(authConfigured({ ...env, NLT_OWNER_VERCEL_SUBS: " , " })).toBe(false);
  });
});

describe("sign-in flow", () => {
  it("login redirects to Vercel with PKCE and sets a state cookie; 503 when unconfigured", () => {
    const flow = startFlow(env);
    expect(flow.out.status).toBe(302);
    expect(flow.location.origin + flow.location.pathname).toBe("https://vercel.com/oauth/authorize");
    expect(flow.location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.location.searchParams.get("client_id")).toBe("cid");
    expect(flow.location.searchParams.get("redirect_uri")).toBe(env.VERCEL_APP_REDIRECT_URI);
    expect(String(flow.out.headers["Set-Cookie"])).toContain("HttpOnly");
    expect(String(flow.out.headers["Set-Cookie"])).toContain("Secure");
    const off = capture();
    login({ method: "GET" }, off.response, { env: {}, fetch: async () => ({ ok: true, json: async () => ({}) }) });
    expect(off.out.status).toBe(503);
  });

  it("signs in an allow-listed owner and the session works, then logout clears it", async () => {
    const flow = startFlow(env);
    const vercel = fakeVercel("owner-2");
    const { out, response } = capture();
    await callback({ method: "GET", query: { code: "abc", state: flow.state }, headers: { cookie: flow.cookie } }, response, { env, fetch: vercel.fetchImpl });
    expect(out.status).toBe(302);
    expect(out.headers.Location).toBe("/");
    const set = out.headers["Set-Cookie"] as string[];
    const sessionCookie = set.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) as string;
    expect(sessionCookie).toContain("HttpOnly");
    expect(set.some((c) => c.startsWith(`${OAUTH_COOKIE}=;`))).toBe(true);
    // The token request carried the PKCE verifier and the secret, but no secret reached the browser.
    expect(vercel.calls[0]?.body).toContain("code_verifier=");
    expect(sessionCookie).not.toContain("csecret");
    expect(vercel.calls[1]?.headers.authorization).toBe("Bearer at-123");

    const cookie = cookiePair(sessionCookie);
    expect(sessionFromCookie(env, cookie)?.name).toBe("Owner Name");
    const s = capture();
    session({ method: "GET", headers: { cookie } }, s.response, { env, fetch: vercel.fetchImpl });
    expect(s.out.body).toEqual({ configured: true, signedIn: true, name: "Owner Name" });
    expect(JSON.stringify(s.out.body)).not.toContain("at-123");

    const l = capture();
    logout({ method: "POST" }, l.response);
    expect(String(l.out.headers["Set-Cookie"])).toContain("Max-Age=0");
  });

  it("also admits an allow-listed username, and rechecks it on each request", async () => {
    const e = { ...env, NLT_OWNER_VERCEL_SUBS: "jdub1216" };
    const flow = startFlow(e);
    const { out, response } = capture();
    await callback({ method: "GET", query: { code: "abc", state: flow.state }, headers: { cookie: flow.cookie } }, response, { env: e, fetch: fakeVercel("some-id", { username: "jdub1216" }).fetchImpl });
    const cookie = cookiePair((out.headers["Set-Cookie"] as string[]).find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes("Max-Age=0")));
    expect(sessionFromCookie(e, cookie)).toBeDefined();
    expect(sessionFromCookie({ ...e, NLT_OWNER_VERCEL_SUBS: "someone-else" }, cookie)).toBeUndefined();
  });

  it("refuses a Vercel user who is not on the allow-list, and sets no session", async () => {
    const flow = startFlow(env);
    const { out, response } = capture();
    await callback({ method: "GET", query: { code: "abc", state: flow.state }, headers: { cookie: flow.cookie } }, response, { env, fetch: fakeVercel("stranger").fetchImpl });
    expect(out.headers.Location).toBe("/?signin=failed");
    expect((out.headers["Set-Cookie"] as string[]).some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes("Max-Age=0"))).toBe(false);
  });

  it("refuses a state mismatch, a missing cookie, a missing code and a failed exchange", async () => {
    const flow = startFlow(env);
    const cases: AuthRequest[] = [
      { method: "GET", query: { code: "abc", state: "other" }, headers: { cookie: flow.cookie } },
      { method: "GET", query: { code: "abc", state: flow.state }, headers: {} },
      { method: "GET", query: { state: flow.state }, headers: { cookie: flow.cookie } },
    ];
    for (const request of cases) {
      const { out, response } = capture();
      const vercel = fakeVercel("owner-1");
      await callback(request, response, { env, fetch: vercel.fetchImpl });
      expect(out.headers.Location).toBe("/?signin=failed");
      expect(vercel.calls).toHaveLength(0);
    }
    for (const options of [{ tokenOk: false }, { infoOk: false }]) {
      const { out, response } = capture();
      await callback({ method: "GET", query: { code: "abc", state: flow.state }, headers: { cookie: flow.cookie } }, response, { env, fetch: fakeVercel("owner-1", options).fetchImpl });
      expect(out.headers.Location).toBe("/?signin=failed");
    }
  });

  it("logs which check failed on the server, without the code, token or secret, and keeps the browser outcome generic", async () => {
    const flow = startFlow(env);
    const ok = { method: "GET", query: { code: "abc", state: flow.state }, headers: { cookie: flow.cookie } };
    const deniedToken: FetchLike = async (url) =>
      url.endsWith("/token") ? { ok: false, status: 401, json: async () => ({ error: "invalid_client", error_description: "csecret at-123" }) } : { ok: true, json: async () => ({}) };
    const cases: { request: AuthRequest; fetch: FetchLike; expected: string }[] = [
      { request: { method: "GET", query: { error: "access_denied", state: flow.state }, headers: { cookie: flow.cookie } }, fetch: fakeVercel("owner-1").fetchImpl, expected: "reason=bad_request vercel_error=access_denied" },
      { request: { method: "GET", query: { code: "abc", state: flow.state }, headers: {} }, fetch: fakeVercel("owner-1").fetchImpl, expected: "reason=bad_request state_cookie_missing_or_expired" },
      { request: { method: "GET", query: { state: flow.state }, headers: { cookie: flow.cookie } }, fetch: fakeVercel("owner-1").fetchImpl, expected: "reason=bad_request code_missing" },
      { request: { method: "GET", query: { code: "abc", state: "other" }, headers: { cookie: flow.cookie } }, fetch: fakeVercel("owner-1").fetchImpl, expected: "reason=bad_request state_mismatch" },
      { request: ok, fetch: deniedToken, expected: "reason=exchange_failed token status=401 error=invalid_client" },
      { request: ok, fetch: fakeVercel("owner-1", { infoOk: false }).fetchImpl, expected: "reason=exchange_failed userinfo status=none error=none sub=string" },
      { request: ok, fetch: fakeVercel("stranger", { username: "someone" }).fetchImpl, expected: "reason=not_allowed sub=stranger username=someone" },
      { request: ok, fetch: fakeVercel("stranger").fetchImpl, expected: "reason=not_allowed sub=stranger username=none" },
    ];
    for (const { request, fetch, expected } of cases) {
      const lines: string[] = [];
      const { out, response } = capture();
      await callback(request, response, { env, fetch, log: (line) => lines.push(line) });
      expect(out.headers.Location).toBe("/?signin=failed");
      expect(lines).toEqual([`nlt-signin: failed ${expected}`]);
      for (const leaked of ["abc", "at-123", "csecret", SECRET, flow.cookie]) expect(lines[0]).not.toContain(leaked);
    }
  });

  it("logs nothing on a successful sign-in", async () => {
    const flow = startFlow(env);
    const lines: string[] = [];
    const { out, response } = capture();
    await callback({ method: "GET", query: { code: "abc", state: flow.state }, headers: { cookie: flow.cookie } }, response, { env, fetch: fakeVercel("owner-1").fetchImpl, log: (line) => lines.push(line) });
    expect(out.headers.Location).toBe("/");
    expect(lines).toEqual([]);
  });

  it("drops a session once the owner is removed from the allow-list or the secret changes", async () => {
    const token = signToken(SECRET, { exp: Math.floor(Date.now() / 1000) + 600, sub: "owner-1", name: "O" });
    const cookie = `${SESSION_COOKIE}=${token}`;
    expect(sessionFromCookie(env, cookie)).toBeDefined();
    expect(sessionFromCookie({ ...env, NLT_OWNER_VERCEL_SUBS: "owner-9" }, cookie)).toBeUndefined();
    expect(sessionFromCookie({ ...env, NLT_SESSION_SECRET: "z".repeat(40) }, cookie)).toBeUndefined();
  });

  it("session reports signed out with no cookie or when unconfigured", () => {
    const a = capture();
    session({ method: "GET" }, a.response, { env, fetch: fakeVercel("x").fetchImpl });
    expect(a.out.body).toEqual({ configured: true, signedIn: false });
    const b = capture();
    session({ method: "GET" }, b.response, { env: {}, fetch: fakeVercel("x").fetchImpl });
    expect(b.out.body).toEqual({ configured: false, signedIn: false });
  });
});
