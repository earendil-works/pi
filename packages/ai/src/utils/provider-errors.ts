const DEFAULT_MAX_ERROR_BODY_CHARS = 4000;

interface ProviderErrorOptions {
	providerName?: string;
	maxBodyChars?: number;
}

interface ErrorWithHttpFields extends Error {
	status?: unknown;
	statusCode?: unknown;
	body?: unknown;
	$metadata?: {
		httpStatusCode?: unknown;
	};
}

export function formatProviderError(error: unknown, options: ProviderErrorOptions = {}): string {
	if (error instanceof Error) {
		const httpError = error as ErrorWithHttpFields;
		const statusCode = getStatusCode(httpError);
		const bodyText = formatBodyText(httpError.body, options.maxBodyChars ?? DEFAULT_MAX_ERROR_BODY_CHARS);
		const message = error.message.trim();
		const prefix = options.providerName ? `${options.providerName} API error` : "Provider API error";

		if (statusCode !== undefined && bodyText && shouldPreferBody(message, statusCode)) {
			return `${prefix} (${statusCode}): ${bodyText}`;
		}
		if (statusCode !== undefined) {
			return `${prefix} (${statusCode}): ${message}`;
		}
		return message;
	}
	return safeJsonStringify(error);
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function getStatusCode(error: ErrorWithHttpFields): number | undefined {
	if (typeof error.status === "number") return error.status;
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	return undefined;
}

function formatBodyText(body: unknown, maxChars: number): string | undefined {
	if (typeof body === "string") {
		const trimmed = body.trim();
		return trimmed ? truncateErrorText(trimmed, maxChars) : undefined;
	}
	if (body === undefined || body === null) return undefined;
	return truncateErrorText(safeJsonStringify(body), maxChars);
}

function shouldPreferBody(message: string, statusCode: number): boolean {
	if (!message) return true;
	const escapedStatusCode = String(statusCode).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return (
		new RegExp(`^${escapedStatusCode}\\s+status code(?: \\(no body\\))?$`, "i").test(message) ||
		/^\(?no body\)?$/i.test(message) ||
		/^unknown(?::\s*unknownerror)?$/i.test(message)
	);
}

function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
