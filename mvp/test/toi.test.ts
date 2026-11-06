import { describe, expect, it } from "vitest";
import {
  verifyToiDocument,
  verifyOtoICharter,
} from "../src/toi/verifier.ts";
import { memoryAllowedByRetention, ALLOWED_RETENTION } from "../src/toi/retention.ts";
import {
  TOIDocumentGenerator,
  generateKeyPair,
  signToi,
} from "@neurolift-technologies/toi";

// Build a valid signed TOI document for tests.
function makeSignedToiDoc() {
  const gen = TOIDocumentGenerator.fromDefaults("test-author");
  gen.validate();
  const { privateKey, publicKeyBase64Url } = generateKeyPair();
  const signed = signToi(gen.toDict(), privateKey);
  return { doc: signed, pubkey: publicKeyBase64Url };
}

// ---- Verifier tests ----

describe("verifyToiDocument", () => {
  const PINNED = "test-pinned-public-key-base64url";

  it("verifies a signed TOI with matching public key and valid signature", () => {
    const { doc, pubkey } = makeSignedToiDoc();
    const result = verifyToiDocument(doc, pubkey);
    expect(result.verified).toBe(true);
  });

  it("fails when no pin is configured", () => {
    const gen = TOIDocumentGenerator.fromDefaults("test-author");
    gen.validate();
    const result = verifyToiDocument(gen.toDict(), undefined);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_pin");
  });

  it("fails when there is no signature", () => {
    const gen = TOIDocumentGenerator.fromDefaults("test-author");
    gen.validate();
    const result = verifyToiDocument(gen.toDict(), PINNED);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("no_signature");
  });

  it("fails on key mismatch", () => {
    const gen = TOIDocumentGenerator.fromDefaults("test-author");
    gen.validate();
    const signed = { ...gen.toDict(), $signature: { alg: "ed25519", public_key: "other-key", value: "sig" } } as any;
    const result = verifyToiDocument(signed, PINNED);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("key_mismatch");
  });

  it("fails on bad signature even with matching key", () => {
    const { doc, pubkey } = makeSignedToiDoc();
    const tampered = { ...doc, $signature: { ...doc.$signature, value: "tampered" } } as any;
    const result = verifyToiDocument(tampered, pubkey);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });
});

describe("verifyOtoICharter", () => {
  it("verifies a charter with matching SHA-256", () => {
    const text = JSON.stringify({ $otoi: "1.0.0" });
    const hash = require("crypto").createHash("sha256").update(text, "utf8").digest("hex");
    const result = verifyOtoICharter(text, hash);
    expect(result.verified).toBe(true);
  });

  it("fails when no pin is configured", () => {
    const result = verifyOtoICharter("{}", undefined);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_pin");
  });

  it("fails on checksum mismatch", () => {
    const result = verifyOtoICharter("{}", "deadbeef");
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("checksum_mismatch");
  });
});

// ---- Retention tests ----

describe("memoryAllowedByRetention", () => {
  function docWithRetention(retention: string | undefined) {
    const gen = TOIDocumentGenerator.fromDefaults("test-author");
    gen.validate();
    const d = gen.toDict() as any;
    if (retention === undefined) {
      delete d.privacy;
    } else {
      d.privacy = { ...d.privacy, retention };
    }
    return d;
  }

  it("allows user-controlled retention", () => {
    expect(memoryAllowedByRetention(docWithRetention("user-controlled"))).toBe(true);
  });

  it("allows long-term retention", () => {
    expect(memoryAllowedByRetention(docWithRetention("long-term"))).toBe(true);
  });

  it("allows permanent retention", () => {
    expect(memoryAllowedByRetention(docWithRetention("permanent"))).toBe(true);
  });

  it("disallows session-only retention", () => {
    expect(memoryAllowedByRetention(docWithRetention("session-only"))).toBe(false);
  });

  it("disallows short-term retention", () => {
    expect(memoryAllowedByRetention(docWithRetention("short-term"))).toBe(false);
  });

  it("disallows missing retention", () => {
    expect(memoryAllowedByRetention(docWithRetention(undefined))).toBe(false);
  });

  it("disallows undefined document", () => {
    expect(memoryAllowedByRetention(undefined)).toBe(false);
  });
});

// ---- ALLOWED_RETENTION export test ----

describe("ALLOWED_RETENTION", () => {
  it("contains the expected retention values", () => {
    expect(ALLOWED_RETENTION.has("user-controlled")).toBe(true);
    expect(ALLOWED_RETENTION.has("long-term")).toBe(true);
    expect(ALLOWED_RETENTION.has("permanent")).toBe(true);
    expect(ALLOWED_RETENTION.has("session-only")).toBe(false);
    expect(ALLOWED_RETENTION.has("short-term")).toBe(false);
  });
});