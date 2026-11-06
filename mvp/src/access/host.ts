/**
 * Host validation for sandbox access requests. Exact hostnames only (no wildcards),
 * no IPs, no localhost, no schemes/ports/paths. The browser never supplies a host
 * for a decision; hosts come only from the agent tool (validated here) or from the
 * server-side database.
 */

const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeHost(host: unknown): string | null {
  if (typeof host !== "string") return null;
  const value = host.trim().toLowerCase();
  if (value.length < 1 || value.length > 253) return null;
  if (value.includes("*") || value.includes(":") || value.includes("/") || value.includes("\\") || /\s/.test(value)) return null;
  if (value === "localhost" || value.endsWith(".localhost")) return null;
  if (!HOST_PATTERN.test(value)) return null;
  const lastLabel = value.slice(value.lastIndexOf(".") + 1);
  if (!/[a-z]/i.test(lastLabel)) return null; // no IP-like final label
  return value;
}

export function sanitizeReason(reason: unknown): string {
  if (typeof reason !== "string") return "";
  // Remove control characters (keep normal whitespace trimmed/collapsed later by display; store as-is minus controls).
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]/g, "");
  return cleaned.slice(0, 200);
}

export const MAX_REASON_LENGTH = 200;
