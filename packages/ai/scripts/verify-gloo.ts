#!/usr/bin/env tsx
/**
 * verify-gloo — fast end-to-end smoke test for the Gloo AI provider.
 *
 * Wraps the live integration into a single CLI so contributors and CI
 * agents can prove "Gloo end-to-end is healthy" in ~15 seconds without
 * spinning up the full pi-coding-agent / pi-mom stack:
 *
 *   1. Branch + node version sanity (informational; no failures here).
 *   2. Credential presence — GLOO_CLIENT_ID + GLOO_CLIENT_SECRET (masked).
 *   3. Static catalog assertions — model count, toolcall:false flags,
 *      decommissioned-model absence, registry lookup.
 *   4. Live OAuth2 client_credentials grant against $GLOO_BASE_URL.
 *   5. Representative streaming smokes:
 *        - Sonnet 4.6 (Anthropic, text)
 *        - GPT-4.1 (OpenAI, text)
 *        - DeepSeek V3.2 (open-source, text)
 *      DeepSeek R1 is intentionally skipped — see
 *      .context/logs/2026-04-29-gloo-deepseek-r1-platform-regression.md.
 *   6. Toolcall-blocklist enforcement — stream against Llama-4-Maverick
 *      with tools attached; the wrapper must strip them before sending
 *      so the platform doesn't HTTP 400 us out.
 *
 * Flags:
 *   --local        require GLOO_BASE_URL to point at localhost; fail loudly
 *                  if pointing at prod.
 *   --no-stream    skip the streaming smoke tests (catalog + OAuth only).
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = at least one check failed
 *   2 = environment misconfiguration (handled before any live calls)
 */

import { GLOO_TOOLCALL_BLOCKLIST } from "../src/providers/gloo.js";
import { getModel, getModels, getProviders } from "../src/models.js";
import "../src/providers/register-builtins.js";
import { streamSimple } from "../src/stream.js";
import type { Context } from "../src/types.js";
import { clearGlooTokenCache, getGlooAccessToken } from "../src/utils/oauth/gloo.js";

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
};
const isTty = process.stdout.isTTY;
const c = (color: keyof typeof ANSI, s: string) => (isTty ? `${ANSI[color]}${s}${ANSI.reset}` : s);

interface CheckResult {
	name: string;
	ok: boolean;
	detail?: string;
	durationMs: number;
}

const results: CheckResult[] = [];

async function check(name: string, fn: () => Promise<string | void> | string | void): Promise<boolean> {
	const start = Date.now();
	try {
		const detail = await fn();
		const ok = true;
		const r: CheckResult = { name, ok, durationMs: Date.now() - start };
		if (detail) r.detail = detail;
		results.push(r);
		console.log(`  ${c("green", "✓")} ${name}${detail ? c("dim", ` — ${detail}`) : ""} ${c("dim", `(${r.durationMs}ms)`)}`);
		return true;
	} catch (error) {
		const r: CheckResult = {
			name,
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - start,
		};
		results.push(r);
		console.log(
			`  ${c("red", "✗")} ${name} ${c("dim", `(${r.durationMs}ms)`)}\n      ${c("red", r.detail ?? "(unknown error)")}`,
		);
		return false;
	}
}

function mask(value: string | undefined, visible = 4): string {
	if (!value) return c("dim", "(missing)");
	if (value.length <= visible) return value;
	return `${value.slice(0, visible)}${c("dim", "…" + value.slice(-2))}`;
}

function shortPrompt(): Context {
	return {
		systemPrompt: "Reply with exactly one short sentence and nothing else.",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "Say hi from Gloo to pi-mono." }],
				timestamp: Date.now(),
			},
		],
	};
}

async function smokeModel(modelId: string): Promise<string> {
	// Models are typed via getModel's overload, but we accept arbitrary ids
	// here for verification flexibility.
	const model = getModel("gloo", modelId as never);
	if (!model) throw new Error(`model not in registry: ${modelId}`);
	const result = await streamSimple(model, shortPrompt(), { maxTokens: 64 }).result();
	if (result.stopReason !== "stop") {
		throw new Error(`stopReason=${result.stopReason} errorMessage=${result.errorMessage ?? "(none)"}`);
	}
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => (block as { text: string }).text)
		.join("")
		.trim();
	return `${result.usage.input}→${result.usage.output} tokens · "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`;
}

async function main(): Promise<number> {
	const args = new Set(process.argv.slice(2));
	const wantLocal = args.has("--local");
	const skipStream = args.has("--no-stream");

	const baseUrl = process.env.GLOO_BASE_URL ?? "https://platform.ai.gloo.com";
	const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");

	console.log(c("bold", "verify-gloo") + c("dim", " · pi-mono · " + new Date().toISOString()));
	console.log(c("dim", "  GLOO_BASE_URL=") + baseUrl + c("dim", isLocal ? " (local)" : " (prod)"));
	console.log(c("dim", "  GLOO_CLIENT_ID=") + mask(process.env.GLOO_CLIENT_ID, 8));
	console.log(c("dim", "  GLOO_CLIENT_SECRET=") + mask(process.env.GLOO_CLIENT_SECRET, 4));
	console.log("");

	if (wantLocal && !isLocal) {
		console.log(c("red", "✗ --local was passed but GLOO_BASE_URL is not localhost. Aborting."));
		return 2;
	}
	if (!wantLocal && isLocal) {
		console.log(
			c(
				"red",
				`✗ GLOO_BASE_URL is ${baseUrl} but --local was not passed. ` +
					"Either start local ai-api and re-run with --local, or unset GLOO_BASE_URL to default to prod.",
			),
		);
		return 2;
	}

	console.log(c("bold", "Static catalog"));
	await check("provider 'gloo' is registered", () => {
		const providers = getProviders();
		if (!providers.includes("gloo")) throw new Error("not in getProviders()");
	});
	await check("catalog has 22 models", () => {
		const n = getModels("gloo").length;
		if (n !== 22) throw new Error(`got ${n}`);
		return `${n} models`;
	});
	await check("toolcall blocklist has 3 entries", () => {
		if (GLOO_TOOLCALL_BLOCKLIST.size !== 3) throw new Error(`got ${GLOO_TOOLCALL_BLOCKLIST.size}`);
		return Array.from(GLOO_TOOLCALL_BLOCKLIST).join(", ");
	});
	await check("decommissioned 'gloo-google-gemini-3-pro-preview' absent", () => {
		const m = getModel("gloo", "gloo-google-gemini-3-pro-preview" as never);
		if (m) throw new Error("still in registry");
	});

	console.log("\n" + c("bold", "Credentials"));
	const hasCreds = !!process.env.GLOO_CLIENT_ID && !!process.env.GLOO_CLIENT_SECRET;
	await check("GLOO_CLIENT_ID + GLOO_CLIENT_SECRET set", () => {
		if (!process.env.GLOO_CLIENT_ID) throw new Error("GLOO_CLIENT_ID missing");
		if (!process.env.GLOO_CLIENT_SECRET) throw new Error("GLOO_CLIENT_SECRET missing");
	});

	if (!hasCreds) {
		console.log("\n" + c("yellow", "Skipping live tier — set GLOO_CLIENT_ID + GLOO_CLIENT_SECRET to run."));
		return summarize();
	}

	console.log("\n" + c("bold", "OAuth"));
	clearGlooTokenCache();
	await check("OAuth2 client_credentials grant succeeds", async () => {
		const token = await getGlooAccessToken();
		if (!token) throw new Error("empty token");
		return `len=${token.length} prefix=${token.slice(0, 12)}…`;
	});
	await check("token is cached after first grant", async () => {
		const t1 = await getGlooAccessToken();
		const t2 = await getGlooAccessToken();
		if (t1 !== t2) throw new Error("cache miss");
		return "shared instance";
	});

	if (skipStream) {
		console.log("\n" + c("yellow", "Skipping streaming smoke tests (--no-stream)."));
		return summarize();
	}

	console.log("\n" + c("bold", "Streaming smokes"));
	await check("gloo-anthropic-claude-sonnet-4.6", () => smokeModel("gloo-anthropic-claude-sonnet-4.6"));
	await check("gloo-openai-gpt-4.1", () => smokeModel("gloo-openai-gpt-4.1"));
	await check(
		"gloo-deepseek-v3.2 (R1 skipped — platform regression 2026-04-29)",
		() => smokeModel("gloo-deepseek-v3.2"),
	);

	console.log("\n" + c("bold", "Toolcall blocklist enforcement"));
	await check("gloo-meta-llama-4-maverick streams when tools present (wrapper strips them)", async () => {
		const model = getModel("gloo", "gloo-meta-llama-4-maverick");
		const ctx: Context = {
			...shortPrompt(),
			tools: [
				{
					name: "noop",
					description: "Returns nothing.",
					parameters: { type: "object", properties: {} },
				},
			],
		};
		const result = await streamSimple(model, ctx, { maxTokens: 64 }).result();
		if (result.stopReason !== "stop") {
			throw new Error(`stopReason=${result.stopReason} errorMessage=${result.errorMessage ?? "(none)"}`);
		}
		return `${result.usage.input}→${result.usage.output} tokens`;
	});

	return summarize();
}

function summarize(): number {
	const passed = results.filter((r) => r.ok).length;
	const failed = results.filter((r) => !r.ok).length;
	const total = results.length;
	const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

	console.log("");
	console.log(c("bold", "Summary"));
	console.log(`  ${passed}/${total} passed${failed ? c("red", ` · ${failed} failed`) : ""} ${c("dim", `· ${totalMs}ms`)}`);

	if (failed > 0) {
		console.log("\n" + c("red", "Failures:"));
		for (const r of results) {
			if (r.ok) continue;
			console.log(`  ${c("red", "✗")} ${r.name}\n      ${r.detail ?? "(no detail)"}`);
		}
		return 1;
	}
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(c("red", "fatal: ") + (error instanceof Error ? error.message : String(error)));
		process.exit(2);
	});
