/**
 * Morph Compaction Extension
 *
 * Replaces the default compaction with Morph's compaction service.
 * Uses the OpenAI-compatible endpoint at api.morphllm.com with the
 * "morph-compactor" model for fast, high-quality context compression.
 *
 * API key resolution (in order):
 *   1. MORPH_API_KEY environment variable
 *   2. ~/.claude/morph/.env file
 *
 * Usage:
 *   pi --extension examples/extensions/morph-compaction.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const MORPH_API_URL = "https://api.morphllm.com/v1/chat/completions";
const MORPH_MODEL = "morph-compactor";

function loadApiKey(): string | undefined {
	// 1. Environment variable
	const envKey = process.env.MORPH_API_KEY;
	if (envKey) return envKey;

	// 2. ~/.claude/morph/.env file
	try {
		const envFile = join(homedir(), ".claude", "morph", ".env");
		const text = readFileSync(envFile, "utf-8");
		for (const line of text.split("\n")) {
			const match = line.match(/^MORPH_API_KEY=(.+)$/);
			if (match) return match[1].trim();
		}
	} catch {
		// File doesn't exist or isn't readable
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const apiKey = loadApiKey();
		if (!apiKey) {
			ctx.ui.notify(
				"MORPH_API_KEY not found. Set it as an environment variable or in ~/.claude/morph/.env. Falling back to default compaction.",
				"warning",
			);
			return;
		}

		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		if (allMessages.length === 0) {
			return;
		}

		const inputChars = allMessages.reduce((n, m) => {
			if ("content" in m && typeof m.content === "string") return n + m.content.length;
			if ("content" in m && Array.isArray(m.content)) {
				return n + m.content.reduce((acc: number, c: any) => acc + (c.text?.length || 0), 0);
			}
			return n;
		}, 0);

		ctx.ui.notify(
			`Morph compaction: compressing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens, ${inputChars.toLocaleString()} chars)...`,
			"info",
		);

		// Serialize conversation to text
		const conversationText = serializeConversation(convertToLlm(allMessages));

		// Include previous summary if available (for iterative compaction)
		const content = previousSummary
			? `Previous summary:\n${previousSummary}\n\nNew conversation to compress:\n${conversationText}`
			: conversationText;

		const startTime = performance.now();

		try {
			const response = await fetch(MORPH_API_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: MORPH_MODEL,
					messages: [{ role: "user", content }],
				}),
				signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Morph API returned ${response.status}: ${errorText}`);
			}

			const data = (await response.json()) as {
				choices: Array<{ message: { content: string } }>;
			};

			const summary = data.choices?.[0]?.message?.content;
			if (!summary?.trim()) {
				if (!signal.aborted) {
					ctx.ui.notify("Morph returned empty summary, falling back to default compaction", "warning");
				}
				return;
			}

			const durationMs = Math.round(performance.now() - startTime);
			const ratio = inputChars > 0 ? ((summary.length / inputChars) * 100).toFixed(1) : "N/A";

			ctx.ui.notify(
				`Morph compaction complete: ${inputChars.toLocaleString()} → ${summary.length.toLocaleString()} chars (${ratio}%) in ${durationMs}ms`,
				"info",
			);

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Morph compaction failed: ${message}. Falling back to default.`, "error");
			return;
		}
	});
}
