/**
 * OpenCode Go limits in footer.
 *
 * Shows subscription quota for `opencode-go` on the 3rd footer line via
 * `ctx.ui.setStatus()`. Core footer is untouched — this extension only
 * reads `after_provider_response` headers, the only quota signal exposed
 * to extensions without core changes.
 *
 * Headers (case-insensitive):
 * - x-ratelimit-remaining / x-ratelimit-limit
 * - ratelimit-remaining / ratelimit-limit (IETF draft)
 * - x-opencode-quota-remaining / x-opencode-quota-limit
 * - x-credits-remaining / x-credits-limit
 *
 * Settings (persisted):
 * - Global: `~/.pi/agent/opencode-go-limits.json`
 * - Project: `.pi/opencode-go-limits.json` (overrides global)
 * ```json
 * { "enabled": true, "mode": "compact" }
 * // mode: "compact" -> "Go 73%"  |  "full" -> "Go 73% (1460/2000)"
 * ```
 * Commands:
 * - `/opencode-limits` — toggle on/off
 * - `/opencode-limits on|off` — explicit
 * - `/opencode-limits compact|full` — display mode
 *
 * Install: copy to `~/.pi/agent/extensions/` or `.pi/extensions/` then
 * `/reload`, or run once with `pi -e ./opencode-go-limits.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

type Limits = {
	remaining?: number;
	limit?: number;
};

type DisplayMode = "compact" | "full";

interface LimitsConfig {
	enabled?: boolean;
	mode?: DisplayMode;
}

function parseNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value.trim());
	return Number.isFinite(n) ? n : undefined;
}

function pickHeader(headers: Record<string, string>, names: string[]): string | undefined {
	for (const name of names) {
		const direct = headers[name] ?? headers[name.toLowerCase()];
		if (direct !== undefined) return direct;
		const lower = name.toLowerCase();
		for (const [k, v] of Object.entries(headers)) {
			if (k.toLowerCase() === lower) return v;
		}
	}
	return undefined;
}

function parseLimits(headers: Record<string, string>): Limits | null {
	const remainingStr = pickHeader(headers, [
		"x-ratelimit-remaining",
		"ratelimit-remaining",
		"x-opencode-quota-remaining",
		"x-credits-remaining",
		"x-quota-remaining",
	]);
	const limitStr = pickHeader(headers, [
		"x-ratelimit-limit",
		"ratelimit-limit",
		"x-opencode-quota-limit",
		"x-credits-limit",
		"x-quota-limit",
	]);
	const remaining = parseNumber(remainingStr);
	const limit = parseNumber(limitStr);
	if (remaining === undefined && limit === undefined) return null;
	return { remaining, limit };
}

function formatLimits(limits: Limits, ctx: ExtensionContext, mode: DisplayMode): string {
	const theme = ctx.ui.theme;
	if (limits.remaining !== undefined && limits.limit !== undefined && limits.limit > 0) {
		const pct = Math.max(0, Math.min(100, (limits.remaining / limits.limit) * 100));
		const pctStr = `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
		if (mode === "compact") {
			const label = `Go ${pctStr}`;
			if (pct < 10) return theme.fg("error", label);
			if (pct < 25) return theme.fg("warning", label);
			return theme.fg("dim", label);
		}
		const label = `Go ${pctStr} (${limits.remaining}/${limits.limit})`;
		if (pct < 10) return theme.fg("error", label);
		if (pct < 25) return theme.fg("warning", label);
		return theme.fg("dim", label);
	}
	if (limits.remaining !== undefined && limits.limit !== undefined) {
		return theme.fg("dim", `Go ${limits.remaining}/${limits.limit}`);
	}
	if (limits.remaining !== undefined) {
		return theme.fg("dim", `Go ${limits.remaining} left`);
	}
	return theme.fg("dim", `Go limit ${limits.limit}`);
}

function configPaths(cwd: string): { global: string; project: string } {
	return {
		global: join(getAgentDir(), "opencode-go-limits.json"),
		project: join(cwd, CONFIG_DIR_NAME, "opencode-go-limits.json"),
	};
}

function loadConfig(cwd: string): LimitsConfig {
	const { global, project } = configPaths(cwd);
	let cfg: LimitsConfig = {};
	for (const p of [global, project]) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf-8")) as LimitsConfig;
			cfg = { ...cfg, ...raw };
		} catch {
			// ignore malformed config, keep previous
		}
	}
	return cfg;
}

function saveConfig(cwd: string, cfg: LimitsConfig): void {
	const { global } = configPaths(cwd);
	try {
		mkdirSync(dirname(global), { recursive: true });
		writeFileSync(global, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
	} catch {
		// ignore write errors (read-only fs, etc.)
	}
}

export default function (pi: ExtensionAPI) {
	const key = "opencode-go";
	let lastLimits: Limits | null = null;
	let enabled = true;
	let displayMode: DisplayMode = "compact";
	let cwd = process.cwd();

	function applyConfig(cfg: LimitsConfig): void {
		if (typeof cfg.enabled === "boolean") enabled = cfg.enabled;
		if (cfg.mode === "compact" || cfg.mode === "full") displayMode = cfg.mode;
	}

	function persist(): void {
		saveConfig(cwd, { enabled, mode: displayMode });
	}

	function syncStatus(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(key, undefined);
			return;
		}
		const isGo = ctx.model?.provider === "opencode-go";
		if (!isGo && !lastLimits) {
			ctx.ui.setStatus(key, undefined);
			return;
		}
		if (!lastLimits) {
			ctx.ui.setStatus(key, ctx.ui.theme.fg("dim", "Go --"));
			return;
		}
		ctx.ui.setStatus(key, formatLimits(lastLimits, ctx, displayMode));
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		applyConfig(loadConfig(cwd));
		syncStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		syncStatus(ctx);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (ctx.model?.provider !== "opencode-go") return;
		const parsed = parseLimits(event.headers);
		if (parsed) {
			lastLimits = parsed;
			syncStatus(ctx);
			return;
		}
		if (event.status === 429 && lastLimits) {
			ctx.ui.setStatus(key, ctx.ui.theme.fg("error", "Go 429 · quota hit"));
		}
	});

	pi.registerCommand("opencode-limits", {
		description: "OpenCode Go limits: /opencode-limits [on|off|compact|full]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				enabled = true;
				persist();
				syncStatus(ctx as ExtensionContext);
				ctx.ui.notify("OpenCode Go limits: on", "info");
				return;
			}
			if (arg === "off") {
				enabled = false;
				persist();
				ctx.ui.setStatus(key, undefined);
				ctx.ui.notify("OpenCode Go limits: off", "info");
				return;
			}
			if (arg === "compact") {
				displayMode = "compact";
				enabled = true;
				persist();
				syncStatus(ctx as ExtensionContext);
				ctx.ui.notify("OpenCode Go limits: compact (Go 73%)", "info");
				return;
			}
			if (arg === "full") {
				displayMode = "full";
				enabled = true;
				persist();
				syncStatus(ctx as ExtensionContext);
				ctx.ui.notify("OpenCode Go limits: full (Go 73% (1460/2000))", "info");
				return;
			}
			if (arg === "") {
				enabled = !enabled;
				persist();
				if (!enabled) {
					ctx.ui.setStatus(key, undefined);
					ctx.ui.notify("OpenCode Go limits: off", "info");
				} else {
					syncStatus(ctx as ExtensionContext);
					ctx.ui.notify(`OpenCode Go limits: on (${displayMode})`, "info");
				}
				return;
			}
			ctx.ui.notify("Usage: /opencode-limits [on|off|compact|full]", "warning");
		},
	});
}
