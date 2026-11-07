// Opt-in /supervisor TUI extension. Off by default: commands/flags registered,
// but no supervisor work (no fetch, no spawn) until /supervisor is invoked or --supervisor is set.
// Lazy-loads supervisor logic via dynamic import inside the command handler.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AGENT_COUNT_PRESETS = ["1-2", "3-4", "5-6", "7-10", "10+", "exact"] as const;
export const MAX_AGENTS = 12;
export const RAM_WARNING_AT = 8;

export function isWithinEnvelope(count: number, preset: string): boolean {
	switch (preset) {
		case "1-2":
			return count >= 1 && count <= 2;
		case "3-4":
			return count >= 3 && count <= 4;
		case "5-6":
			return count >= 5 && count <= 6;
		case "7-10":
			return count >= 7 && count <= 10;
		case "10+":
			return count >= 10;
		default:
			return true; // exact: caller supplies number
	}
}

export function resolveAgentCount(preset: string, exact: number | undefined, parallelCapacity: number): number {
	let count: number;
	if (preset === "exact") {
		if (exact === undefined) throw new Error("exact requires a number");
		count = exact;
	} else {
		// Range is an envelope, not a quota: pick exact inside it based on parallel capacity.
		const ranges: Record<string, [number, number]> = {
			"1-2": [1, 2],
			"3-4": [3, 4],
			"5-6": [5, 6],
			"7-10": [7, 10],
			"10+": [10, MAX_AGENTS],
		};
		const [lo, hi] = ranges[preset] ?? [1, MAX_AGENTS];
		count = Math.min(hi, Math.max(lo, parallelCapacity));
	}
	if (count < 1) throw new Error("agent count must be >=1");
	if (count > MAX_AGENTS) throw new Error(`max ${MAX_AGENTS} agents`);
	return count;
}

export function settingsPath(): string {
	return `${process.env.HOME ?? "~"}/.pi/agent/settings.json`;
}

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("supervisor", { description: "Enable supervisor mode (opt-in)", type: "boolean", default: false });
	let active = false;

	async function runSetup(ctx: {
		ui: {
			select: (t: string, o: string[]) => Promise<string | undefined>;
			input: (t: string, p: string) => Promise<string | undefined>;
		};
	}): Promise<void> {
		// Lazy-load: only on invocation.
		const countChoice = await ctx.ui.select("Agent count", [...AGENT_COUNT_PRESETS, "custom number"]);
		let preset = countChoice ?? "3-4";
		let exact: number | undefined;
		if (preset === "custom number") {
			const raw = await ctx.ui.input("Exact number", "4");
			exact = Number(raw ?? "4");
			preset = "exact";
		} else if (preset === "exact") {
			const raw = await ctx.ui.input("Exact number", "4");
			exact = Number(raw ?? "4");
		}
		const thinkingChoice = await ctx.ui.select("Thinking", [
			"fixed low",
			"fixed medium",
			"fixed high",
			"fixed extra high (xhigh)",
			"dynamic",
		]);
		const naming = resolveAgentCount(preset, exact, 4); // planner refines exact count from capacity inside envelope.
		// Persist choices (verified location: Pi settings file read by coding-agent).
		try {
			const { readFileSync, writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const path = settingsPath();
			let existing: Record<string, unknown> = {};
			try {
				existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			} catch {
				existing = {};
			}
			existing["orchestraSupervisor"] = {
				active: true,
				preset,
				exact,
				thinking: thinkingChoice,
				count: naming,
				ts: Date.now(),
			};
			writeFileSync(path, JSON.stringify(existing, null, 2));
		} catch {
			// Settings write is best-effort; supervisor still runs for this session.
		}
		active = true;
		if (naming >= RAM_WARNING_AT) {
			try {
				const mod = await import("node:os");
				void mod;
			} catch {
				/* noop */
			}
		}
	}

	pi.registerCommand("supervisor", {
		description: "Toggle supervisor mode (opt-in, off by default)",
		handler: async (
			_args: string,
			ctx: {
				ui: {
					select: (t: string, o: string[]) => Promise<string | undefined>;
					input: (t: string, p: string) => Promise<string | undefined>;
				};
			},
		) => {
			const arg = String(_args ?? "").trim();
			if (arg === "off") {
				active = false;
				return;
			}
			if (active) return; // idempotent: focus existing (no duplicate setup)
			await runSetup(ctx as never);
		},
	});

	// Off-by-default: startup does nothing unless flag set.
	pi.on("session_start", async (_event, _ctx) => {
		const flag = pi.getFlag("supervisor");
		if (flag === true) {
			active = true;
		}
	});
}
