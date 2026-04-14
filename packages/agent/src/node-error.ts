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

function parseNodeErrorCodesList(raw: string): string[] {
	const codes: string[] = [];
	for (const part of raw.split(",")) {
		const code = part.trim();
		if (code.length > 0 && !codes.includes(code)) {
			codes.push(code);
		}
	}
	return codes;
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

export function extractNodeErrorCodesFromMessage(message: string | undefined): string[] {
	if (!message) return [];

	const parsedCodes: string[] = [];
	for (const line of message.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("Node.js error code: ")) {
			const code = trimmed.slice("Node.js error code: ".length).trim();
			if (code.length > 0 && !parsedCodes.includes(code)) {
				parsedCodes.push(code);
			}
			continue;
		}
		if (trimmed.startsWith("Node.js error codes: ")) {
			for (const code of parseNodeErrorCodesList(trimmed.slice("Node.js error codes: ".length))) {
				if (!parsedCodes.includes(code)) {
					parsedCodes.push(code);
				}
			}
		}
	}

	for (const knownCode of NODE_TLS_CERTIFICATE_ERROR_CODES) {
		if (message.includes(knownCode) && !parsedCodes.includes(knownCode)) {
			parsedCodes.push(knownCode);
		}
	}

	return parsedCodes;
}

export function appendNodeErrorCodes(message: string, codes: readonly string[]): string {
	if (codes.length === 0) return message;
	if (message.includes("Node.js error code:") || message.includes("Node.js error codes:")) {
		return message;
	}
	const label = codes.length === 1 ? "Node.js error code" : "Node.js error codes";
	return `${message}\n${label}: ${codes.join(", ")}`;
}

export function isNodeTlsCertificateErrorCode(code: string): boolean {
	return NODE_TLS_CERTIFICATE_ERROR_CODES.has(code);
}
