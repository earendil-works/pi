// Adapted from pi-antigravity (MIT), Copyright (c) 2026 Rahul Arya.
// See LICENSE in this directory.
import type { ProviderEnv, TranscriptContext } from "../../types.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { getModelEnum } from "./models.ts";

export function antigravityEnv(name: string, env?: ProviderEnv): string | undefined {
	return getProviderEnvValue(`ANTIGRAVITY_${name}`, env) ?? getProviderEnvValue(`NOAGY_${name}`, env);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeText(text: unknown): string {
	return sanitizeSurrogates(String(text ?? ""));
}

/** Deterministic UUIDv4-flavored derivation (agy cascade/trajectory ids are v4, never v5/v7). */
export async function stableUuid(seed: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(seed))).slice(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable negative-int64 session id (agy's sessionId shape, e.g. -3750763034362895579),
 * derived from the seed so it stays constant for the whole session.
 */
export async function stableInt64Id(seed: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(seed))).slice(0, 8);
	bytes[0] |= 0x80; // agy-observed values are negative; keep the sign bit set.
	return String(new DataView(bytes.buffer).getBigInt64(0, false));
}

/** Random negative-int64 fallback when no session seed is available. */
export function randomNegativeInt64(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	bytes[0] |= 0x80;
	return String(new DataView(bytes.buffer).getBigInt64(0, false));
}

export async function resolveSessionTrajectory(
	context: TranscriptContext,
	sessionId?: string,
	/** Credential-stashed persistent session id; wins over the per-session derivation. */
	deviceSessionId?: string,
) {
	const first = context.messages[0];
	const content =
		typeof first?.content === "string"
			? first.content.slice(0, 64)
			: JSON.stringify(first?.content ?? "").slice(0, 64);
	const seed = sessionId?.trim()
		? `session:${sessionId.trim()}`
		: `${first?.role ?? "user"}:${first?.timestamp ?? ""}:${content}`;
	return {
		conversationId: await stableUuid(`antigravity:conv:${seed}`),
		trajectoryId: await stableUuid(`antigravity:traj:${seed}`),
		// agy persists one negative-int64 session id per install; the credential-stashed
		// value wins, and the session-seeded derivation stays the fallback for credentials
		// minted before the field existed.
		sessionInt64Id: deviceSessionId ?? (await stableInt64Id(`antigravity:sess:${seed}`)),
	};
}

export async function antigravityRequestEnvelope(
	wireModelId: string,
	options: {
		isClaude: boolean;
		isNonGemini: boolean;
		step: number;
		lastStepIndex: string;
		requestIndex: number;
		conversationId: string;
		trajectoryId: string;
		/** Stable negative-int64 session id from resolveSessionTrajectory; random when omitted. */
		sessionInt64Id?: string;
		modelEnum?: string;
	},
) {
	const { conversationId, trajectoryId, step } = options;
	const sessionId = options.sessionInt64Id || randomNegativeInt64();
	const modelEnum = options.modelEnum ?? getModelEnum(wireModelId);
	// agy emits exactly these labels, Go-map-sorted alphabetically on the wire. cascade_id and
	// root_cascade_id are the cascade UUID also carried in the requestId's first path segment.
	const labels: Record<string, string> = {
		cascade_id: conversationId,
		last_step_index: options.lastStepIndex,
		request_id: `${trajectoryId}-${options.requestIndex}`,
		root_cascade_id: conversationId,
		trajectory_id: trajectoryId,
		used_claude: String(options.isClaude),
		used_claude_conservative: String(options.isClaude),
		used_non_gemini_model: String(options.isNonGemini),
	};
	if (modelEnum) labels.model_enum = modelEnum;
	if (step > 1) labels.last_execution_id = await stableUuid(`antigravity:exec:${trajectoryId}:${step - 1}`);
	const sortedLabels = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	return {
		requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`,
		sessionId,
		labels: sortedLabels,
	};
}
