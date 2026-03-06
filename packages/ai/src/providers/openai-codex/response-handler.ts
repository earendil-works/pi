/**
 * Response handling for Codex SSE streams.
 */

export type CodexRateLimit = {
	used_percent?: number;
	window_minutes?: number;
	resets_at?: number;
};

export type CodexRateLimits = {
	primary?: CodexRateLimit;
	secondary?: CodexRateLimit;
};

export type CodexErrorInfo = {
	message: string;
	status: number;
	friendlyMessage?: string;
	rateLimits?: CodexRateLimits;
	raw?: string;
};

function toNumber(v: string | null): number | undefined {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function toInt(v: string | null): number | undefined {
	if (v == null) return undefined;
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : undefined;
}

export function parseCodexRateLimits(headers: Headers): CodexRateLimits | undefined {
	const primary = {
		used_percent: toNumber(headers.get("x-codex-primary-used-percent")),
		window_minutes: toInt(headers.get("x-codex-primary-window-minutes")),
		resets_at: toInt(headers.get("x-codex-primary-reset-at")),
	};
	const secondary = {
		used_percent: toNumber(headers.get("x-codex-secondary-used-percent")),
		window_minutes: toInt(headers.get("x-codex-secondary-window-minutes")),
		resets_at: toInt(headers.get("x-codex-secondary-reset-at")),
	};

	return primary.used_percent !== undefined || secondary.used_percent !== undefined
		? { primary, secondary }
		: undefined;
}

export async function parseCodexError(response: Response): Promise<CodexErrorInfo> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;
	const rateLimits = parseCodexRateLimits(response.headers);

	try {
		const parsed = JSON.parse(raw) as { error?: Record<string, unknown> };
		const err = parsed?.error ?? {};

		const code = String((err as { code?: string; type?: string }).code ?? (err as { type?: string }).type ?? "");
		const resetsAt =
			(err as { resets_at?: number }).resets_at ??
			rateLimits?.primary?.resets_at ??
			rateLimits?.secondary?.resets_at;
		const mins = resetsAt ? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000)) : undefined;

		if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
			const planType = (err as { plan_type?: string }).plan_type;
			const plan = planType ? ` (${String(planType).toLowerCase()} plan)` : "";
			const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
			friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
		}

		const errMessage = (err as { message?: string }).message;
		message = errMessage || friendlyMessage || message;
	} catch {
		// raw body not JSON
	}

	return {
		message,
		status: response.status,
		friendlyMessage,
		rateLimits,
		raw,
	};
}

/**
 * Parse SSE stream from Codex response.
 */
export async function* parseCodexSseStream(response: Response): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) {
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let index = buffer.indexOf("\n\n");
		while (index !== -1) {
			const chunk = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const event = parseSseChunk(chunk);
			if (event) yield event;
			index = buffer.indexOf("\n\n");
		}
	}

	if (buffer.trim()) {
		const event = parseSseChunk(buffer);
		if (event) yield event;
	}
}

function parseSseChunk(chunk: string): Record<string, unknown> | null {
	const lines = chunk.split("\n");
	const dataLines: string[] = [];

	for (const line of lines) {
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trim());
		}
	}

	if (dataLines.length === 0) return null;
	const data = dataLines.join("\n").trim();
	if (!data || data === "[DONE]") return null;

	try {
		return JSON.parse(data) as Record<string, unknown>;
	} catch {
		return null;
	}
}
