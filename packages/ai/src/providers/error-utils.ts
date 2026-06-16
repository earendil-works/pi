export function formatProviderError(error: unknown, providerName: string): string {
	if (error instanceof Error) {
		const sdkError = error as Error & {
			statusCode?: unknown;
			status?: unknown;
			body?: unknown;
			error?: unknown;
			$response?: { statusCode?: unknown; body?: unknown };
			$metadata?: { httpStatusCode?: unknown };
		};

		// 1. Extract status code
		const status =
			typeof sdkError.statusCode === "number"
				? sdkError.statusCode
				: typeof sdkError.status === "number"
					? sdkError.status
					: typeof sdkError.$response?.statusCode === "number"
						? sdkError.$response.statusCode
						: typeof sdkError.$metadata?.httpStatusCode === "number"
							? sdkError.$metadata.httpStatusCode
							: undefined;

		// 2. Extract raw body text
		let bodyText: string | undefined;
		const rawBody = sdkError.body ?? sdkError.$response?.body;
		if (typeof rawBody === "string") {
			bodyText = rawBody.trim();
		} else if (rawBody && typeof rawBody === "object") {
			if (rawBody instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(rawBody))) {
				bodyText = new TextDecoder().decode(rawBody as Uint8Array).trim();
			} else {
				try {
					bodyText = JSON.stringify(rawBody).trim();
				} catch {
					// Ignore stringify error
				}
			}
		}

		// Also check sdkError.error if bodyText is not found (OpenAI APIError uses .error for parsed JSON)
		if (!bodyText && sdkError.error) {
			if (typeof sdkError.error === "string") {
				bodyText = sdkError.error.trim();
			} else if (typeof sdkError.error === "object") {
				const errObj = sdkError.error as Record<string, unknown>;
				if (typeof errObj.message === "string") {
					bodyText = errObj.message.trim();
				} else {
					try {
						bodyText = JSON.stringify(sdkError.error).trim();
					} catch {
						// Ignore stringify error
					}
				}
			}
		}

		// 3. Try to parse error message if it's a JSON string (e.g. from Google SDK)
		let parsedMsg: string | undefined;
		if (error.message.startsWith("{") && error.message.endsWith("}")) {
			try {
				const parsed = JSON.parse(error.message) as Record<string, unknown>;
				// Google Gen AI error shape: { error: { message, code, status } }
				if (parsed && typeof parsed === "object") {
					const innerError = (parsed.error || parsed) as Record<string, unknown>;
					if (innerError && typeof innerError === "object") {
						const msgVal = innerError.message || innerError.statusText || innerError.status;
						if (typeof msgVal === "string") {
							parsedMsg = msgVal;
						} else {
							parsedMsg = JSON.stringify(innerError);
						}
					}
				}
			} catch {
				// Ignore parse error
			}
		}

		const detailMessage = parsedMsg || error.message;

		// 4. Combine status code and body/message
		if (status !== undefined) {
			if (bodyText) {
				return `${providerName} API error (${status}): ${truncateErrorText(bodyText, 4000)}`;
			}
			return `${providerName} API error (${status}): ${detailMessage}`;
		}

		return detailMessage;
	}

	return safeJsonStringify(error);
}

function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
