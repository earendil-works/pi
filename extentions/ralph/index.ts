/**
 * Ralph Extension — Autonomous completion loop
 *
 * Detects when the agent stops mid-task and re-prompts to continue.
 * Inspired by frankbria/ralph-claude-code, adapted natively for pi.
 *
 * Loop prevention: max retries per agent session (resets on new user message).
 * Won't fire on quality-gate turns (checks for [quality-gate] marker).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RALPH_MARKER = "[ralph]";
const QUALITY_GATE_MARKER = "[quality-gate]";
const PRE_COMMIT_GATE_MARKER = "[pre-commit-gate]";

// Signals that the agent stopped before finishing
const INCOMPLETION_PATTERNS = [
	/\bi(?:'ll| will) (?:now |then )?(?:continue|proceed|finish|complete|handle|implement|add|create|fix|update|move on)/i,
	/\blet me (?:now |then )?(?:continue|proceed|finish|complete|handle|implement|add|create|fix|update)/i,
	/\bstill need(?:s)? to\b/i,
	/\bnext,? I (?:need to|should|will|'ll)\b/i,
	/\bremaining (?:steps|tasks|items|work|changes)\b/i,
	/\bI haven'?t (?:yet|finished|completed)\b/i,
	/\btodo:?\s/i,
	/\bnow let'?s\b/i,
	/\bmoving on to\b/i,
	/\bI(?:'ll| will) (?:also |now )?need to\b/i,
	/\bhere'?s (?:what|the plan|my plan)\b.*(?:next|remaining|left)\b/i,
];

// Signals that the agent actually finished — don't re-prompt
const COMPLETION_PATTERNS = [
	/\ball (?:done|complete|finished|tasks? (?:are |have been )?(?:done|complete))/i,
	/\bsuccessfully (?:completed|finished|implemented|fixed|resolved)/i,
	/\bnothing (?:left|remaining|else) to (?:do|fix|change|implement)/i,
	/\bready for (?:review|testing|you)\b/i,
	/\blet me know if (?:you'd like|you need|there'?s)\b/i,
	/\bis there anything else\b/i,
	/\bshall I\b/i,
];

function getLastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const texts: string[] = [];
			for (const part of msg.content) {
				if (part.type === "text") texts.push(part.text);
			}
			return texts.join("\n");
		}
	}
	return "";
}

function hasMarker(messages: any[], marker: string): boolean {
	for (const msg of messages) {
		if (msg.role === "user") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.includes(marker)) return true;
			}
		}
	}
	return false;
}

function detectIncompletion(text: string): string | null {
	// Check completion signals first — if the agent wrapped up, don't re-prompt
	for (const pat of COMPLETION_PATTERNS) {
		if (pat.test(text)) return null;
	}

	// Check the last ~500 chars for incompletion signals (end of response matters most)
	const tail = text.slice(-500);
	for (const pat of INCOMPLETION_PATTERNS) {
		const match = tail.match(pat);
		if (match) return match[0];
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let maxRetries = 5;
	let retryCount = 0;

	pi.registerCommand("ralph", {
		description: "Toggle Ralph autonomous completion loop (on/off) or set max retries: /ralph 3",
		handler: async (args, ctx) => {
			const num = parseInt(args, 10);
			if (!isNaN(num) && num > 0) {
				maxRetries = num;
				ctx.ui.notify(`Ralph: max retries set to ${maxRetries}`, "info");
				return;
			}
			enabled = !enabled;
			retryCount = 0;
			ctx.ui.notify(`Ralph: ${enabled ? "ON" : "OFF"} (max ${maxRetries} retries)`, "info");
		},
	});

	pi.registerCommand("continue", {
		description: "Manually nudge the agent to continue where it left off",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Wait for it to finish.", "warning");
				return;
			}
			retryCount = 0;
			pi.sendUserMessage(`${RALPH_MARKER} Continue where you left off. Complete all remaining work.`);
		},
	});

	pi.on("agent_end", (event) => {
		if (!enabled) return;

		// Don't interfere with quality-gate or pre-commit-gate turns
		if (hasMarker(event.messages, QUALITY_GATE_MARKER) || hasMarker(event.messages, PRE_COMMIT_GATE_MARKER)) return;

		// Reset retry count if this was a fresh user turn (no ralph marker)
		const isRalphRetry = hasMarker(event.messages, RALPH_MARKER);
		if (!isRalphRetry) {
			retryCount = 0;
		}

		// Check retry limit
		if (retryCount >= maxRetries) return;

		// Analyze the last assistant message
		const lastText = getLastAssistantText(event.messages);
		if (!lastText) return;

		const signal = detectIncompletion(lastText);
		if (!signal) return;

		retryCount++;

		const prompt =
			retryCount < maxRetries
				? `${RALPH_MARKER} You stopped mid-task (detected: "${signal}"). Continue where you left off and complete the remaining work. [retry ${retryCount}/${maxRetries}]`
				: `${RALPH_MARKER} Final attempt (${retryCount}/${maxRetries}). Finish all remaining work now or summarize what's left as a TODO list. Do NOT start new work — wrap up.`;

		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	});
}
