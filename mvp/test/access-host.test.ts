import { describe, expect, it } from "vitest";
import { normalizeHost, sanitizeReason } from "../src/access/host.ts";

describe("normalizeHost", () => {
  it("accepts exact hostnames and lowercases", () => {
    expect(normalizeHost("Docs.Example.com")).toBe("docs.example.com");
    expect(normalizeHost("a.b.co")).toBe("a.b.co");
  });
  it("rejects wildcards, IPs, localhost, schemes, ports, paths, spaces, empty", () => {
    for (const bad of ["*.example.com", "*", "127.0.0.1", "::1", "localhost", "foo.localhost", "https://example.com", "example.com:443", "example.com/path", "exam ple.com", "", "   ", 5, null, undefined, "a".repeat(254)]) {
      expect(normalizeHost(bad as unknown)).toBeNull();
    }
  });
  it("rejects labels that are not hostnames", () => {
    expect(normalizeHost("example.123")).toBeNull();
  });
});

describe("sanitizeReason", () => {
  it("strips control chars and caps length", () => {
    expect(sanitizeReason("hi\u0000\u0007there")).toBe("hithere");
    expect(sanitizeReason("x".repeat(300)).length).toBe(200);
    expect(sanitizeReason(5)).toBe("");
  });
});
