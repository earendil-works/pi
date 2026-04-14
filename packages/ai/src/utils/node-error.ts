const NODE_TLS_CERTIFICATE_ERROR_CODES = new Set<string>([
	"CERT_CHAIN_TOO_LONG",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"CERT_REJECTED",
	"CERT_SIGNATURE_FAILURE",
	"CERT_UNTRUSTED",
	"CRL_HAS_EXPIRED",
	"CRL_NOT_YET_VALID",
	"CRL_SIGNATURE_FAILURE",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"HOSTNAME_MISMATCH",
	"INVALID_CA",
	"INVALID_PURPOSE",
	"PATH_LENGTH_EXCEEDED",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

interface ErrorLike {
	message?: unknown;
	code?: unknown;
	cause?: unknown;
	errors?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as ErrorLike;
}

function getErrorMessage(value: unknown): string {
	if (value instanceof Error) {
		return value.message;
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "object" && value !== null) {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function getRootMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return getErrorMessage(error);
	}

	const cause = asErrorLike(error.cause);
	const causeMessage = typeof cause?.message === "string" ? cause.message : undefined;
	if (error.message === "fetch failed" && causeMessage) {
		return `fetch failed: ${causeMessage}`;
	}

	return error.message;
}

export function collectNodeErrorCodes(error: unknown): string[] {
	const queue: unknown[] = [error];
	const seen = new Set<unknown>();
	const codes: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);

		const entry = asErrorLike(current);
		if (!entry) continue;

		if (typeof entry.code === "string" && entry.code.length > 0 && !codes.includes(entry.code)) {
			codes.push(entry.code);
		}
		if (entry.cause !== undefined) {
			queue.push(entry.cause);
		}
		if (Array.isArray(entry.errors)) {
			for (const nested of entry.errors) {
				queue.push(nested);
			}
		}
	}

	return codes;
}

export function isNodeTlsCertificateErrorCode(code: string): boolean {
	return NODE_TLS_CERTIFICATE_ERROR_CODES.has(code);
}

export function formatProviderError(error: unknown): string {
	const rootMessage = getRootMessage(error).trim() || "Unknown error";
	const codes = collectNodeErrorCodes(error);
	if (codes.length === 0) {
		return rootMessage;
	}

	const label = codes.length === 1 ? "Node.js error code" : "Node.js error codes";
	return `${rootMessage}\n${label}: ${codes.join(", ")}`;
}
