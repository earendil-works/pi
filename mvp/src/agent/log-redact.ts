/**
 * Redaction for text that goes into the server log.
 *
 * A turn's failure reason is an error message from the gateway, the sandbox, the SDK or the safety gate. Such a
 * message is not known to be safe: it can quote a header, a URL with a signed query string, a token, or part of a
 * request. Before it is logged it is reduced here. Line breaks and other control characters become spaces (one
 * logical line per event), credential-shaped values are replaced, every URL query string is dropped, and the result
 * is shortened.
 *
 * This is pattern-based, not a guarantee: text that does not look like a credential (for example, words quoted from
 * a prompt) is not recognised and stays. The stable part of the log line is the turn's `status`; the reason is extra
 * detail. The owner-facing reason in the chat page is not passed through here.
 */

/** Longest redacted reason written to the log. */
export const MAX_LOGGED_REASON_LENGTH = 300;

const REDACTED = "[redacted]";

/** Replacements applied in order. Each pattern is global so every occurrence is replaced. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization schemes followed by a credential: "Bearer abc", "Basic abc=", "Token abc".
  // The credential must be at least 12 token characters, so ordinary words ("invalid token provided") stay.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${REDACTED}`],
  // JSON Web Tokens (three base64url segments, the first starting with the encoded "{"").
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED],
  // Query strings: keep the scheme, host and path, drop everything after "?".
  [/(\bhttps?:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi, `$1?${REDACTED}`],
  // name=value or name: value where the name says it is a secret.
  [
    /\b(authorization|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|token|cookie|session|signature|sig)(["']?\s*[=:]\s*["']?)[^\s,;&"']+/gi,
    `$1$2${REDACTED}`,
  ],
  // Well-known credential prefixes.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(?:vck|vcp|vca)_[A-Za-z0-9]{16,}/g, REDACTED],
  // Any other long run of token-like characters (32 or more) is treated as a credential.
  [/[A-Za-z0-9_\-+/=]{32,}/g, REDACTED],
];

/** Returns `text` with credentials, query strings and control characters removed, shortened for the log. */
export function redactForLog(text: string, maxLength = MAX_LOGGED_REASON_LENGTH): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
  let out = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  out = out.replace(/\s{2,}/g, " ").trim();
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
