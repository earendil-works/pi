import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function taskHash(prompt: string): string {
  return sha256Hex(prompt);
}

export function generateNonce(): { nonce: string; nonceHash: string } {
  const nonce = randomBytes(16).toString("hex"); // 128 bits
  return { nonce, nonceHash: sha256Hex(nonce) };
}
