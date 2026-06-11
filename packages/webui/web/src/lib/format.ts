/**
 * Format a token count for display.
 * Token statistics only show what has already happened, never predict.
 * Format: N.NK / N.NM / N.NB
 */
export function formatToken(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return "0";
  }
  if (n < 1000) {
    return `${n}`;
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  if (n < 1_000_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Format a relative time string from an ISO date.
 * Returns human-readable relative time (e.g., "just now", "5m ago").
 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}
