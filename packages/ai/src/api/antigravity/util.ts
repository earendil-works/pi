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

/** Same deterministic UUID derivation as the extension, without Node-only imports. */
export async function stableUuid(seed: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(seed))).slice(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function resolveSessionTrajectory(context: TranscriptContext, sessionId?: string) {
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
	},
) {
	const { conversationId, trajectoryId, step } = options;
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	const sessionId = String(new DataView(bytes.buffer).getBigInt64(0, true));
	const labels: Record<string, string> = {
		last_step_index: options.lastStepIndex,
		request_id: `${trajectoryId}-${options.requestIndex}`,
		trajectory_id: trajectoryId,
		used_claude: String(options.isClaude),
		used_claude_conservative: String(options.isClaude),
		used_non_gemini_model: String(options.isNonGemini),
	};
	const modelEnum = getModelEnum(wireModelId);
	if (modelEnum) labels.model_enum = modelEnum;
	if (step > 1) labels.last_execution_id = await stableUuid(`antigravity:exec:${trajectoryId}:${step - 1}`);
	return { requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`, sessionId, labels };
}
