// Adapted from pi-antigravity (MIT), Copyright (c) 2026 Rahul Arya.
// See LICENSE in this directory.

const ALLOWED_API_HOST_SUFFIXES = [".googleapis.com", ".sandbox.googleapis.com"];

/** Prevent token exfiltration via poisoned BASE_URL (SSRF / credential leak). */
export function assertSafeApiBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid ANTIGRAVITY_BASE_URL: ${raw}`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`ANTIGRAVITY_BASE_URL must use https (got ${url.protocol})`);
	}
	if (url.username || url.password) {
		throw new Error("ANTIGRAVITY_BASE_URL must not include credentials");
	}
	const host = url.hostname.toLowerCase();
	const allowed = host === "googleapis.com" || ALLOWED_API_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
	if (!allowed) {
		throw new Error(`ANTIGRAVITY_BASE_URL host "${host}" is not allowed. Use a *.googleapis.com endpoint.`);
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path === "/" ? "" : path}`;
}

/** Redact bearer tokens, refresh tokens, and similar secrets from diagnostics/errors. */
export function redactSecrets(text: string): string {
	return text
		.replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
		.replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
		.replace(
			/("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
			"$1[redacted]$2",
		)
		.replace(
			/("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*)[^\s&,}]+/gi,
			"$1[redacted]",
		);
}

export function safeError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactSecrets(raw);
}
