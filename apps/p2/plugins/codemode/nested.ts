// A script's calls of other tools as the chat and the terminal show them (web.tsx, tui.ts): while it runs, Durable's
// live nested slots (`tool.calls`, internal tools by their script name); once settled, the final list its result keeps
// in `details.calls` (Durable's `CodemodeToolDetails`).
import { isInterruptedError } from "@p2/app/v1";
import type { NestedCall, ToolStatus } from "@p2/app/v1/web";

/** A settled call's status in `details.calls`: a call still running when the script ended was cut short with it. */
const SETTLED: Readonly<Record<string, ToolStatus>> = {
	ok: "done",
	error: "error",
	cancelled: "interrupted",
	running: "interrupted",
};

/**
 * The final list of a script's result `details`: `{ calls: [{ id, name, args (cut JSON), status: "ok" | "error" |
 * "cancelled", durationMs?, error? }] }`. Only the script's own calls are listed, so every row is at depth 0.
 * Undefined without a list; null for a malformed one.
 */
export function settledCalls(callId: string, details: unknown): readonly NestedCall[] | null | undefined {
	if (!details || typeof details !== "object" || !("calls" in details) || !Array.isArray(details.calls)) return;
	const calls: NestedCall[] = [];
	for (const call of details.calls as unknown[]) {
		if (!call || typeof call !== "object") return null;
		const row = call as Record<string, unknown>;
		if (typeof row.id !== "number" || typeof row.name !== "string" || typeof row.args !== "string") return null;
		if (!Object.hasOwn(SETTLED, String(row.status))) return null;
		let args: Record<string, unknown> | string = row.args;
		try {
			const parsed: unknown = JSON.parse(row.args);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
		} catch {}
		calls.push({
			id: `${callId}/c${row.id}`,
			name: row.name,
			args,
			status: row.status === "error" && isInterruptedError(row.error) ? "interrupted" : SETTLED[String(row.status)]!,
			depth: 0,
			...(typeof row.durationMs === "number" ? { durationMs: row.durationMs } : {}),
			...(typeof row.error === "string" ? { error: row.error } : {}),
		});
	}
	return calls;
}

/** Code mode's internal tools' prefix (`pi.codemode.models.classify`): scripts call them by the rest. */
const INTERNAL = /^pi\.codemode\./;

/**
 * A script call's own calls: the settled list from its result's details (none when it is malformed, rather than wrong
 * rows), else the live (or last seen) ones with internal tools by their script name, as the settled list has them.
 */
export function scriptCalls(tool: {
	id: string;
	details?: unknown;
	calls?: readonly NestedCall[];
}): readonly NestedCall[] | undefined {
	const settled = settledCalls(tool.id, tool.details);
	if (settled !== undefined) return settled ?? undefined;
	const live = tool.calls;
	return live?.some((call) => INTERNAL.test(call.name))
		? live.map((call) => (INTERNAL.test(call.name) ? { ...call, name: call.name.replace(INTERNAL, "") } : call))
		: live;
}

/** How an entry of a script's calls that groups `count` identical calls in a row says so. */
export const repeatedRuns = (count: number, failed: number): string =>
	`${count} runs${failed ? `, ${failed} failed` : ""}`;
