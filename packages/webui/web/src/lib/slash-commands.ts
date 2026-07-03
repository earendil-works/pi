// Pure logic for webui slash-command dispatch.
//
// Slash-command semantics in the webui:
//   - Built-in commands (/compact) are dispatched locally by the chat page;
//     the result is a typed intent the page acts on.
//   - User-defined quick commands are expanded into prompt text and sent
//     through the regular prompt path.
//   - Anything else (extension commands, prompt templates, skills) is left
//     to the pi process — the webui does not parse it.

import type { QuickCommand } from "./api";

export type SlashResolveResult =
	| { kind: "compact"; customInstructions?: string }
	| { kind: "quick"; expanded: string }
	| { kind: "passthrough" };

/**
 * Names the webui claims for built-in dispatch. These cannot be reused as
 * user-defined quick command names. Mirrors a subset of pi's
 * `BUILTIN_SLASH_COMMANDS` (`packages/coding-agent/src/core/slash-commands.ts`)
 * — only the names that have a real webui action today.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
	"compact",
	"new",
	"model",
	"bash",
]);

/**
 * Token used in quick command `prompt` templates to receive the text the
 * user typed after the command name. Single substitution, no escaping —
 * `$ARG` is replaced with the raw argument string, nothing more.
 */
export const ARG_TOKEN = "$ARG";

/**
 * Substitute `$ARG` in `prompt` with `arg`. The token is replaced once;
 * occurrences after the first are left as-is so users see they typoed.
 */
export function expandTemplate(prompt: string, arg: string): string {
	const idx = prompt.indexOf(ARG_TOKEN);
	if (idx === -1) return prompt;
	return prompt.slice(0, idx) + arg + prompt.slice(idx + ARG_TOKEN.length);
}

/**
 * Classify a raw user-typed line.
 *
 * - `/compact` (with optional `customInstructions` after a single space)
 *   resolves to `{kind:"compact",...}`.
 * - `/<name> <arg...>` where `<name>` matches a user-defined command
 *   resolves to `{kind:"quick", expanded}` after `$ARG` substitution.
 * - Otherwise `{kind:"passthrough"}` — the input is sent verbatim to the
 *   pi process (which itself handles extension / template / skill commands).
 */
export function resolveSlashCommand(
	input: string,
	quickCommands: QuickCommand[],
): SlashResolveResult {
	const text = input.trim();
	if (!text.startsWith("/")) return { kind: "passthrough" };

	// Split off the first whitespace-separated token: "/foo bar baz" -> ["foo", "bar baz"]
	const firstSpace = text.indexOf(" ");
	const name = firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace);
	const rest = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();

	if (name === "compact") {
		return rest ? { kind: "compact", customInstructions: rest } : { kind: "compact" };
	}

	const cmd = quickCommands.find((c) => c.name === name);
	if (cmd) {
		return { kind: "quick", expanded: expandTemplate(cmd.prompt, rest) };
	}

	return { kind: "passthrough" };
}

/**
 * Validate a candidate quick command. Returns null when valid, otherwise a
 * short human-readable error suitable for display under the row.
 *
 * Rules:
 *   - name: 1-64 chars, [a-z0-9_-], lowercase first char
 *   - prompt: 1-4096 chars
 *   - name not in RESERVED_NAMES
 *   - name unique within `existing` (case-sensitive)
 */
export function validateQuickCommand(
	candidate: QuickCommand,
	existing: ReadonlyArray<QuickCommand>,
	ignoreIndex?: number,
): string | null {
	const { name, prompt } = candidate;
	if (typeof name !== "string" || name.length === 0) return "name is required";
	if (name.length > 64) return "name must be at most 64 characters";
	if (!/^[a-z0-9_-]+$/.test(name)) return "name may only contain a-z, 0-9, _ and -";
	if (RESERVED_NAMES.has(name)) return `'${name}' is a reserved command name`;
	const dupe = existing.findIndex((c, i) => c.name === name && i !== ignoreIndex);
	if (dupe !== -1) return `another command named '${name}' already exists`;
	if (typeof prompt !== "string" || prompt.length === 0) return "prompt is required";
	if (prompt.length > 4096) return "prompt must be at most 4096 characters";
	return null;
}