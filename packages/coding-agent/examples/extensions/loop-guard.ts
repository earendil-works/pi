/**
 * Loop Guard Extension
 *
 * Detects when the agent repeats the identical tool call (same tool + same
 * arguments) many times in a row — a common LLM failure mode where the model
 * retries a check that can never succeed (e.g. curl-ing a client-rendered
 * page and grepping for content that only appears after JS runs).
 *
 * Behavior:
 * - Counts consecutive identical tool calls (toolName + stable-stringified input).
 * - At `warnThreshold` (default 3): non-blocking warning via ctx.ui.notify.
 * - At `blockThreshold` (default 6): blocks the call. If UI is available, asks
 *   the user whether to allow once / keep blocking / stop the agent turn.
 *   Without UI, blocks outright.
 * - Any different tool call resets the counter.
 * - Per-toolCallId allow-once so a user-approved retry isn't re-blocked.
 *
 * Tunables via env vars:
 *   PI_LOOP_GUARD_WARN   (default 3)
 *   PI_LOOP_GUARD_BLOCK  (default 6)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WARN_THRESHOLD = Math.max(1, Number(process.env.PI_LOOP_GUARD_WARN ?? 3));
const BLOCK_THRESHOLD = Math.max(WARN_THRESHOLD, Number(process.env.PI_LOOP_GUARD_BLOCK ?? 6));

/** Stable stringify: sort object keys so {a:1,b:2} === {b:2,a:1}. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Short human-readable summary of a tool call for messages. */
function summarize(toolName: string, input: Record<string, unknown>): string {
	const raw =
		(typeof input.command === "string" && input.command) ||
		(typeof input.path === "string" && input.path) ||
		(typeof input.query === "string" && input.query) ||
		stableStringify(input);
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return `${toolName}(${oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine})`;
}

export default function (pi: ExtensionAPI) {
	// Fingerprint of the current consecutive run, and how many times seen.
	let currentKey: string | null = null;
	let currentCount = 0;
	let currentLabel = "";
	// toolCallIds the user explicitly allowed once.
	const allowedOnce = new Set<string>();
	// When the user picks "stop", we keep blocking this key for the rest of the turn.
	const blockedKeys = new Set<string>();

	pi.on("session_start", async () => {
		currentKey = null;
		currentCount = 0;
		currentLabel = "";
		allowedOnce.clear();
		blockedKeys.clear();
	});

	pi.on("turn_start", async () => {
		// A new turn means user input arrived — reset hard-blocked keys.
		blockedKeys.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (allowedOnce.has(event.toolCallId)) {
			allowedOnce.delete(event.toolCallId);
			return undefined;
		}

		const key = `${event.toolName}:${stableStringify(event.input)}`;

		if (key === currentKey) {
			currentCount += 1;
		} else {
			currentKey = key;
			currentCount = 1;
			currentLabel = summarize(event.toolName, event.input);
		}

		// Hard-blocked earlier this turn: keep blocking without re-prompting.
		if (blockedKeys.has(key)) {
			return {
				block: true,
				reason: `Loop guard: "${currentLabel}" already repeated ${currentCount}x; user chose to stop.`,
				terminate: true,
			};
		}

		if (currentCount < WARN_THRESHOLD) return undefined;

		if (currentCount < BLOCK_THRESHOLD) {
			ctx.ui.notify(`Loop guard: identical call repeated ${currentCount}x — ${currentLabel}`, "warning");
			return undefined;
		}

		// At/over block threshold.
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Loop guard: "${currentLabel}" repeated ${currentCount}x with no progress. Blocked (no UI to confirm). Change approach instead of retrying.`,
				terminate: true,
			};
		}

		const choice = await ctx.ui.select(
			`Loop guard: the agent has run the identical call ${currentCount}x in a row:\n\n  ${currentLabel}\n\nThis usually means the check can never succeed. What do you want to do?`,
			["Block & stop this turn", "Allow once", "Keep blocking (ask again next time)"],
		);

		if (choice === "Allow once") {
			allowedOnce.add(event.toolCallId);
			return undefined;
		}

		if (choice === "Keep blocking (ask again next time)") {
			return {
				block: true,
				reason: `Loop guard: "${currentLabel}" repeated ${currentCount}x. Blocked by user. Try a different approach.`,
			};
		}

		// Default: "Block & stop this turn" (also when dialog is dismissed).
		blockedKeys.add(key);
		return {
			block: true,
			reason: `Loop guard: "${currentLabel}" repeated ${currentCount}x. Blocked and turn stopped by user. Do NOT retry this call — change approach.`,
			terminate: true,
		};
	});
}
