/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Without a UI the call is blocked instead of running.
 *
 * Problem: a raw-string pattern match both misses and misfires. Example:
 * `rm -fr /x` slips past a `rm -rf` pattern, while `echo "do not run rm -rf /"`
 * trips it even though nothing is deleted.
 * Solution: split the command into segments, tokenize each segment honoring
 * quotes, unwrap wrappers to the real command, then check the leading command
 * and its flags structurally. A segment is dangerous only when its own
 * structure says so.
 *
 * Checked (any matching segment prompts):
 * - rm with a recursive flag (-r, -R, -rf, -fr, --recursive, combined or separate)
 * - find with -delete, or -exec/-execdir running a recursive rm
 * - dd with an of= target, mkfs commands, git clean with -f
 * - chmod/chown with a 777 mode (numeric 0777/777, or symbolic a=rwx / u=rwx,g=rwx,o=rwx)
 * - sudo, including sudo wrapping a dangerous command (privilege elevation
 *   alone prompts, as before)
 * Deliberately not inspected: script files run by path, and output redirection
 * (a redirect target's danger depends on the working directory, which this
 * check does not resolve). Command substitution nested deeper than two
 * levels prompts as uninspectable rather than passing silently.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_UNWRAP_STEPS = 4;
const MAX_SUBSTITUTION_DEPTH = 2;

function basename(command: string): string {
	const slash = command.lastIndexOf("/");
	return slash >= 0 ? command.slice(slash + 1) : command;
}

/** Split a command into segments on top-level operators, honoring quotes and escapes. */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote = "";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote !== "") {
			current += ch;
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[i + 1];
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")" || ch === "<") {
			if (current.trim() !== "") segments.push(current);
			current = "";
			if (ch === "&" && command[i + 1] === "&") i++;
			if (ch === "|" && command[i + 1] === "|") i++;
			continue;
		}
		if (ch === ">") {
			if (current.trim() !== "") segments.push(current);
			current = "";
			if (command[i + 1] === ">") i++;
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") segments.push(current);
	return segments;
}

/** Tokenize one segment, honoring quotes and backslash escapes. Quotes are stripped. */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote = "";
	let hasToken = false;
	const flush = () => {
		if (hasToken) {
			tokens.push(current);
			current = "";
			hasToken = false;
		}
	};
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote !== "") {
			if (ch === quote) {
				quote = "";
			} else if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
				current += segment[i + 1];
				i++;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			current += segment[i + 1];
			hasToken = true;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			hasToken = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			flush();
			continue;
		}
		current += ch;
		hasToken = true;
	}
	flush();
	return tokens;
}

/** Extract $(...) and `...` substitution bodies from a command, with placeholders left in place. */
function extractSubstitutions(command: string): { cleaned: string; nested: string[] } {
	const nested: string[] = [];
	let cleaned = "";
	let i = 0;
	while (i < command.length) {
		if (command[i] === "$" && command[i + 1] === "(") {
			let depth = 1;
			let j = i + 2;
			while (j < command.length && depth > 0) {
				if (command[j] === "(") depth++;
				else if (command[j] === ")") depth--;
				j++;
			}
			nested.push(command.slice(i + 2, j - 1));
			cleaned += " __SUBST__ ";
			i = j;
			continue;
		}
		if (command[i] === "`") {
			const end = command.indexOf("`", i + 1);
			if (end === -1) break;
			nested.push(command.slice(i + 1, end));
			cleaned += " __SUBST__ ";
			i = end + 1;
			continue;
		}
		cleaned += command[i];
		i++;
	}
	return { cleaned, nested };
}

function isFlagToken(token: string): boolean {
	return token.startsWith("-") && token !== "-";
}

function shortFlagLetters(token: string): string {
	if (!token.startsWith("-") || token.startsWith("--") || token === "-") return "";
	return token.slice(1);
}

/** Flags of a command up to (not including) a bare `--` terminator. */
function flagsOf(args: string[]): string[] {
	const flags: string[] = [];
	for (const token of args) {
		if (token === "--") break;
		flags.push(token);
	}
	return flags;
}

function rmIsRecursive(args: string[]): boolean {
	for (const token of flagsOf(args)) {
		if (token === "--recursive") return true;
		const letters = shortFlagLetters(token);
		if (letters !== "" && /[rR]/.test(letters)) return true;
	}
	return false;
}

function findIsDestructive(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-delete") return true;
		if (args[i] === "-exec" || args[i] === "-execdir") {
			const inner: string[] = [];
			for (let j = i + 1; j < args.length && args[j] !== ";"; j++) inner.push(args[j]);
			if (inner.length > 0 && basename(inner[0]) === "rm" && rmIsRecursive(inner.slice(1))) return true;
		}
	}
	return false;
}

function modeIs777(args: string[]): boolean {
	for (const token of args) {
		if (/^0?777$/.test(token)) return true;
		if (token === "a=rwx") return true;
		if (token.includes("u=rwx") && token.includes("g=rwx") && token.includes("o=rwx")) return true;
	}
	return false;
}

function gitCleanIsDestructive(args: string[]): boolean {
	if (!args.includes("clean")) return false;
	for (const token of flagsOf(args)) {
		const letters = shortFlagLetters(token);
		if (letters !== "" && letters.includes("f")) return true;
	}
	return false;
}

/** Reason one tokenized segment is dangerous, or undefined when it is not. */
function segmentReason(tokens: string[], depth: number): string | undefined {
	if (tokens.length === 0) return undefined;
	let index = 0;
	let sudoSeen = false;
	for (let step = 0; step < MAX_UNWRAP_STEPS; step++) {
		const head = basename(tokens[index]);
		if (head === "sudo") {
			sudoSeen = true;
			let next = index + 1;
			while (next < tokens.length && isFlagToken(tokens[next])) {
				if (tokens[next] === "-u" || tokens[next] === "--user") next += 2;
				else if (tokens[next].startsWith("--user=")) next += 1;
				else if (tokens[next] === "--") {
					next += 1;
					break;
				} else next += 1;
			}
			if (next >= tokens.length) return "sudo shell (no command)";
			index = next;
			continue;
		}
		if (head === "env") {
			let next = index + 1;
			while (next < tokens.length) {
				const token = tokens[next];
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
					next += 1;
					continue;
				}
				if (token === "-i") {
					next += 1;
					continue;
				}
				if (token === "-u" || token === "--unset") {
					next += 2;
					continue;
				}
				if (token === "--") {
					next += 1;
					break;
				}
				break;
			}
			if (next >= tokens.length) return undefined;
			index = next;
			continue;
		}
		if (head === "command") {
			const rest = tokens.slice(index + 1);
			if (rest.includes("-v") || rest.includes("-p")) return undefined;
			let next = index + 1;
			while (next < tokens.length && isFlagToken(tokens[next])) next += 1;
			if (next >= tokens.length) return undefined;
			index = next;
			continue;
		}
		if (head === "nice" || head === "time") {
			let next = index + 1;
			while (next < tokens.length && isFlagToken(tokens[next])) {
				if (tokens[next] === "-n") next += 2;
				else next += 1;
			}
			if (next >= tokens.length) return undefined;
			index = next;
			continue;
		}
		if (head === "sh" || head === "bash") {
			const dashC = tokens.indexOf("-c", index + 1);
			if (dashC === -1 || dashC + 1 >= tokens.length) return undefined;
			if (depth >= MAX_SUBSTITUTION_DEPTH) return "shell wrapper (not inspected past nesting limit)";
			return dangerousCommandReason(tokens[dashC + 1], depth + 1);
		}
		break;
	}
	const command = basename(tokens[index]);
	const args = tokens.slice(index + 1);
	let reason: string | undefined;
	if (command === "rm" && rmIsRecursive(args)) reason = "rm with recursive flag";
	else if (command === "find" && findIsDestructive(args)) reason = "find deleting files";
	else if (command === "dd" && args.some((token) => token.startsWith("of="))) reason = "dd with of= target";
	else if (command === "mkfs" || command.startsWith("mkfs.")) reason = "mkfs filesystem creation";
	else if ((command === "chmod" || command === "chown") && modeIs777(args)) reason = "chmod/chown 777";
	else if (command === "git" && gitCleanIsDestructive(args)) reason = "git clean -f";
	if (reason !== undefined) return reason;
	if (sudoSeen) return "sudo (privilege elevation)";
	return undefined;
}

/**
 * Reason a command is dangerous, or undefined when no segment is dangerous.
 * Segments are checked independently; one dangerous segment flags the command.
 */
export function dangerousCommandReason(command: string, depth = 0): string | undefined {
	const { cleaned, nested } = extractSubstitutions(command);
	for (const segment of splitSegments(cleaned)) {
		const reason = segmentReason(tokenize(segment), depth);
		if (reason !== undefined) return reason;
	}
	if (depth < MAX_SUBSTITUTION_DEPTH) {
		for (const inner of nested) {
			const reason = dangerousCommandReason(inner, depth + 1);
			if (reason !== undefined) return reason;
		}
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const reason = dangerousCommandReason(command);

		if (reason !== undefined) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: `Dangerous command blocked (no UI for confirmation): ${reason}` };
			}

			const choice = await ctx.ui.select(`Dangerous command (${reason}):\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
