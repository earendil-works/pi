import { describe, expect, it } from "vitest";
import { MAX_LOGGED_REASON_LENGTH, redactForLog } from "../src/agent/log-redact.ts";

// Every credential below is synthetic.
describe("redactForLog", () => {
  it("removes authorization values and keeps the scheme and the useful words", () => {
    const out = redactForLog("Gateway 401: Authorization: Bearer abcDEF0123456789xyz rejected");
    expect(out).not.toContain("abcDEF0123456789xyz");
    expect(out).toContain("Gateway 401");
    expect(out).toContain("rejected");
    expect(redactForLog("Basic dXNlcjpwYXNzd29yZA== was refused")).toBe("Basic [redacted] was refused");
  });

  it("keeps ordinary words that only follow the word token", () => {
    expect(redactForLog("Invalid token provided")).toBe("Invalid token provided");
  });

  it("drops URL query strings but keeps the host and path", () => {
    const out = redactForLog("GET https://sandbox.example/v1/files?sig=s3cr3t&expires=1&token=t0k3n failed (403)");
    expect(out).toBe("GET https://sandbox.example/v1/files?[redacted] failed (403)");
  });

  it("removes secret-named values, JWTs and well-known token formats", () => {
    const samples: Record<string, string> = {
      "api_key=AbC123xyz": "AbC123xyz",
      'client_secret: "hunter2hunter2"': "hunter2hunter2",
      "password=pa55word": "pa55word",
      "x-api-key: k-9988": "k-9988",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl": "eyJzdWIiOiIxIn0",
      "key sk-proj-ABCDEFGH12345678": "sk-proj-ABCDEFGH12345678",
      "gh ghp_0123456789abcdefABCDEF": "ghp_0123456789abcdefABCDEF",
      "pat github_pat_11AAAAAAA0123456789abcd": "github_pat_11AAAAAAA0123456789abcd",
      "slack xoxb-1234567890-abcdef": "xoxb-1234567890-abcdef",
      "aws AKIAABCDEFGHIJKLMNOP": "AKIAABCDEFGHIJKLMNOP",
      "vercel vck_0123456789abcdefABCD": "vck_0123456789abcdefABCD",
      [`long ${"Q".repeat(40)} value`]: "Q".repeat(40),
    };
    for (const [input, secret] of Object.entries(samples)) {
      const out = redactForLog(input);
      expect(out, input).not.toContain(secret);
      expect(out, input).toContain("[redacted]");
    }
  });

  it("keeps one log line: control characters and line breaks become spaces", () => {
    const out = redactForLog("first\nnlt-signin: forged\r\n\u0000second\u2028third");
    expect(out).toBe("first nlt-signin: forged second third");
    expect(out).not.toMatch(/[\r\n\u0000\u2028]/);
  });

  it("shortens after redacting, so a cut can't leave part of a secret", () => {
    const out = redactForLog(`${"word ".repeat(100)}Bearer abcDEF0123456789xyz`);
    expect(out.length).toBeLessThanOrEqual(MAX_LOGGED_REASON_LENGTH + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(redactForLog("short")).toBe("short");
  });
});
