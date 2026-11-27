/**
 * Error responses of the Google AI Ultra plan endpoint (`:createPerUserQuota`), turned into messages for the user.
 *
 * The message is always Google's own text, plus a hint where that text does not say what to do (sign in again,
 * upgrade, switch model). Only 429s need a retry decision: a per-minute limit is retried, while a daily limit or a
 * model the plan does not include must fail at once. Other statuses are not retried by the shared retry rules anyway.
 *
 * Bodies come in three shapes: a JSON object, a JSON array of `google.rpc.Status` objects (401 and gateway 403s),
 * and an SSE `event: error` frame (some errors of streaming requests).
 */

/** What the user sees, and whether the request fails at once instead of going through the shared retry rules. */
export interface GoogleInteractionsError {
	message: string;
	final: boolean;
}

interface ErrorBody {
	message: string;
	/** `ErrorInfo.reason`, e.g. `ACCESS_TOKEN_SCOPE_INSUFFICIENT`. */
	reason?: string;
	/** The `QuotaFailure` violation of a per-day quota, with its limit when Google sends one. */
	perDayQuota?: { limit?: number };
}

/** Which kind of 429 a response is, following the classifier in Google's partner docs (errors-and-limits). */
type RateLimit = { kind: "per-minute" } | { kind: "not-on-plan" } | { kind: "daily"; resetInMessage: boolean };

const PLANS_URL = "https://one.google.com/ai";
const SIGN_IN_AGAIN = "Run /login to sign in again.";

/** Classify a non-2xx response: Google's message plus a hint, and whether a 429 must not be retried. */
export function classifyGoogleInteractionsError(input: {
	status: number;
	headers: Headers;
	body: string;
	modelId: string;
}): GoogleInteractionsError {
	const { status, headers, modelId } = input;
	const error = parseErrorBody(input.body);
	const message = (hint: string | undefined) => [String(status), error.message, hint].filter(Boolean).join(" ");

	if (status === 429) {
		const limit = classifyRateLimit(error);
		switch (limit.kind) {
			case "per-minute":
				return { message: message(undefined), final: false };
			case "not-on-plan":
				return { message: message(notOnPlan(modelId)), final: true };
			case "daily": {
				const reset = limit.resetInMessage ? "" : formatReset(headers);
				// "Daily limit reached for" marks the message as not retryable for pi's agent-level retry (utils/retry.ts).
				const hint = `Daily limit reached for ${modelId}${reset}: switch to another model, or use a Gemini API key.`;
				return { message: message(hint), final: true };
			}
		}
	}
	return { message: message(hintFor(status, error, modelId)), final: false };
}

function classifyRateLimit(error: ErrorBody): RateLimit {
	const dailyMessage = /reached today's .*? limit/i.test(error.message);
	const perDayMessage = /rate limit exceeded(?: for model \S+)? \(limit: (\d+) (?:tokens|requests) per day\)/i.exec(
		error.message,
	);
	if (!dailyMessage && !perDayMessage && !error.perDayQuota) return { kind: "per-minute" };
	// A daily limit of zero means the plan does not include the model.
	if (error.perDayQuota?.limit === 0 || perDayMessage?.[1] === "0") return { kind: "not-on-plan" };
	return { kind: "daily", resetInMessage: dailyMessage };
}

function hintFor(status: number, error: ErrorBody, modelId: string): string | undefined {
	if (status === 400 && /not supported for per-user quota/i.test(error.message)) return notOnPlan(modelId);
	if (status === 401) return SIGN_IN_AGAIN;
	// Flat error bodies carry no `ErrorInfo`, so Google's classifier also matches the message.
	if (
		status === 403 &&
		(error.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient authentication scopes/i.test(error.message))
	) {
		return SIGN_IN_AGAIN;
	}
	// Our project's API is disabled or the client is blocked (the kill switch); the user cannot fix that.
	if (
		status === 403 &&
		(error.reason === "SERVICE_DISABLED" || /oauth client is not authorized/i.test(error.message))
	) {
		return "The Google AI Ultra plan is currently unavailable in pi.";
	}
	if (status === 402 || status === 403) {
		return `Your Google account does not have an eligible Google AI Ultra plan. Upgrade at ${PLANS_URL}, or use a Gemini API key.`;
	}
	return undefined;
}

// "is not available on the Google AI Ultra plan" marks the message as not retryable for pi's agent-level retry.
function notOnPlan(modelId: string): string {
	return `${modelId} is not available on the Google AI Ultra plan. Choose another model.`;
}

/** " (resets in 5h 18m)" from `Retry-After` seconds, or "" when absent. */
function formatReset(headers: Headers): string {
	const seconds = Number(headers.get("retry-after"));
	if (!Number.isFinite(seconds) || seconds <= 0) return "";
	const totalMinutes = Math.ceil(seconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return ` (resets in ${hours > 0 ? `${hours}h ` : ""}${minutes}m)`;
}

/** Read message, `ErrorInfo.reason` and the per-day quota from any of the three body shapes; falls back to the raw text. */
function parseErrorBody(body: string): ErrorBody {
	const trimmed = body.trim();
	const json = /^[[{]/.test(trimmed)
		? trimmed
		: trimmed
				.split("\n")
				.find((line) => line.startsWith("data:"))
				?.slice(5)
				.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(json ?? "");
	} catch {
		return { message: trimmed };
	}
	const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
	// Wire input: the body shape is not guaranteed.
	const error = (first as { error?: { message?: unknown; details?: unknown } } | null)?.error;
	if (typeof error?.message !== "string") return { message: trimmed };
	const details = Array.isArray(error.details) ? (error.details as Record<string, unknown>[]) : [];
	const reason = details.find((d) => String(d["@type"]).endsWith("google.rpc.ErrorInfo"))?.reason;
	const violations = details.find((d) => String(d["@type"]).endsWith("google.rpc.QuotaFailure"))?.violations;
	const perDay = Array.isArray(violations)
		? (violations as { quotaId?: unknown; quotaValue?: unknown }[]).find(
				(v) => typeof v.quotaId === "string" && v.quotaId.includes("PerDay"),
			)
		: undefined;
	// `quotaValue` is an int64, which JSON carries as a string.
	const value = perDay?.quotaValue;
	const limit = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
	return {
		message: error.message,
		...(typeof reason === "string" && { reason }),
		...(perDay && { perDayQuota: Number.isFinite(limit) ? { limit } : {} }),
	};
}
