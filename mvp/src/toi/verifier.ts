/**
 * TOI / OTOI verification, server side only.
 *
 * TOI: `$signature.public_key` must equal the pinned `NLT_TOI_PUBKEY`, then
 * `verifyToi` must return true. Both checks must pass; a missing pin, a key
 * mismatch, or a failed signature means the TOI is unverifiable.
 *
 * OTOI: SHA-256 of the charter text must equal the pinned `NLT_OTOI_SHA256`.
 *
 * All checks return a result object (never throw) so callers fail closed.
 * Logs carry the operation name only: never text, keys, checksums, or file
 * contents.
 */

import { createHash } from "node:crypto";
import type { ToiDocument } from "@neurolift-technologies/toi";
import { verifyToi } from "@neurolift-technologies/toi";

export interface ToiVerifyResult {
  verified: boolean;
  /** Human-free reason when not verified (for logging, never the key itself). */
  reason?: string;
}

export interface OtoIVerifyResult {
  verified: boolean;
  reason?: string;
}

/**
 * Verify a parsed `.toi` document against the pinned public key.
 * Returns `{ verified: true }` only when the embedded public key matches the
 * pin and the embedded signature is valid.
 */
export function verifyToiDocument(
  doc: ToiDocument,
  pinnedPubkey: string | undefined,
): ToiVerifyResult {
  if (!pinnedPubkey) {
    return { verified: false, reason: "missing_pin" };
  }
  const signature = doc.$signature;
  if (!signature || typeof signature.public_key !== "string") {
    return { verified: false, reason: "no_signature" };
  }
  if (signature.public_key !== pinnedPubkey) {
    return { verified: false, reason: "key_mismatch" };
  }
  if (!verifyToi(doc)) {
    return { verified: false, reason: "bad_signature" };
  }
  return { verified: true };
}

/**
 * Verify an `.otoi` charter against the pinned SHA-256.
 * Returns `{ verified: true }` only when the charter's SHA-256 matches the pin.
 */
export function verifyOtoICharter(
  charterText: string,
  pinnedSha256: string | undefined,
): OtoIVerifyResult {
  if (!pinnedSha256) {
    return { verified: false, reason: "missing_pin" };
  }
  const digest = createHash("sha256").update(charterText, "utf8").digest("hex");
  if (digest !== pinnedSha256) {
    return { verified: false, reason: "checksum_mismatch" };
  }
  return { verified: true };
}