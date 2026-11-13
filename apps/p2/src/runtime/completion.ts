// `@` and Tab file completion text handling, shared by the TUI provider and the web composers (p2-tui-port.md section
// 8.4). Pure copies of pi-tui autocomplete.ts helpers (token boundaries, quoting, `@`/path prefix extraction,
// completion insertion, forced-Tab gating) without its filesystem and `fd` parts: suggestions come from the session's
// `FileIndex`. Completion is cwd-relative only: `~`, absolute and `..` prefixes complete nothing (section 8.2).

const cjkBreak =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const cjkPunctuation = new RegExp(`(?:(?=\\p{Punctuation})${cjkBreak.source}|[，．：；！？（）［］｛｝“”‘’…—])`, "u");
const separator = new RegExp(`(?:\\s|${cjkPunctuation.source})`, "u");
const boundary = new RegExp(`(?:^|${separator.source})`, "u");
const tokenStart = new RegExp(`${boundary.source}$`, "u");
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
// Opening wrappers that may precede a path in prose, mapped to their closing counterpart.
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

export type CompletionItem = { value: string; label: string; description?: string };

/**
 * Chat mode's agent mention as a whole token (plugins/chat-mode/contract.ts `mentionPattern`): `@pi`, or the agent's
 * name in the conversation. Never completed as a file.
 */
export const isMentionToken = (at: string, name = "Pi"): boolean => at.toLowerCase() === `@${name.toLowerCase()}`;

/** The mention offered first while chat mode is on (`name`: the agent's name there), when the typed prefix starts it. */
export function mentionItems(rawPrefix: string, name: string | undefined): CompletionItem[] {
	if (!name) return [];
	const token = name.toLowerCase();
	return token.startsWith(rawPrefix.toLowerCase())
		? [{ value: `@${token}`, label: `@${token}`, description: `mention ${name}` }]
		: [];
}

function findLastDelimiter(text: string): number {
	let last = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || separator.test(character)) last = index - 1;
	}
	return last;
}

// "(~/Dev" -> "~/Dev", "`src/ma" -> "src/ma"; a wrapper whose closer is in the token stays ("app/[slug]/pa").
function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]!];
		if (!closer || result.includes(closer, 1)) break;
		result = result.slice(1);
	}
	return result;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let start = -1;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) start = i;
		}
	}
	return inQuotes ? start : null;
}

function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1]!]) start -= 1;
	return PATH_DELIMITERS.has(text[start - 1] ?? "") || tokenStart.test(text.slice(0, start));
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) return null;
	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) return null;
		return text.slice(quoteStart - 1);
	}
	if (!isTokenStart(text, quoteStart)) return null;
	return text.slice(quoteStart);
}

export function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	if (prefix.startsWith('"')) return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	if (prefix.startsWith("@")) return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

export function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || separator.test(path);
	const prefix = options.isAtPrefix ? "@" : "";
	if (!needsQuotes) return `${prefix}${path}`;
	return `${prefix}"${path}"`;
}

/** The `@` token before the cursor (`@src/ma`, `@"my file`), or null. */
export function extractAtPrefix(text: string): string | null {
	const quoted = extractQuotedPrefix(text);
	if (quoted?.startsWith('@"')) return quoted;
	const last = findLastDelimiter(text);
	const token = stripLeadingWrappers(last === -1 ? text : text.slice(last + 1));
	return token.startsWith("@") ? token : null;
}

/** A path-like token before the cursor; with `force` (Tab) any token, else only path-looking ones. */
export function extractPathPrefix(text: string, force = false): string | null {
	const quoted = extractQuotedPrefix(text);
	if (quoted) return quoted;
	const last = findLastDelimiter(text);
	const prefix = stripLeadingWrappers(last === -1 ? text : text.slice(last + 1));
	if (force) return prefix;
	if (prefix.includes("/") || prefix.startsWith(".") || prefix.startsWith("~/")) return prefix;
	if (prefix === "" && text !== "" && tokenStart.test(text)) return prefix;
	return null;
}

/** pi-tui: forced Tab completes files unless a slash command name is being typed. */
export function shouldTriggerFileCompletion(textBeforeCursor: string): boolean {
	const trimmed = textBeforeCursor.trim();
	return !(trimmed.startsWith("/") && !trimmed.includes(" "));
}

/** Paths that leave the session directory complete nothing (cwd-relative only). */
export function outOfScope(rawPrefix: string): boolean {
	return /^(?:\/|~|\.\.(?:\/|$))/.test(rawPrefix);
}

/** Items for `@` completion (pi's `getFuzzyFileSuggestions` labels: the name, the path as description). */
export function atItems(
	results: readonly { path: string; dir: boolean }[],
	options: { isQuotedPrefix: boolean },
): CompletionItem[] {
	return results.map(({ path, dir }) => {
		const name = path.slice(path.lastIndexOf("/") + 1);
		return {
			value: buildCompletionValue(dir ? `${path}/` : path, {
				isDirectory: dir,
				isAtPrefix: true,
				isQuotedPrefix: options.isQuotedPrefix,
			}),
			label: name + (dir ? "/" : ""),
			description: path,
		};
	});
}

/**
 * Tab path completion over one directory's entries (pi-tui `getFileSuggestions`, cwd-relative): `dir` is the listed
 * directory ("" for the root), `name` the typed part of the last segment. Directories first, then names.
 */
export function pathCompletion(rawPrefix: string): { dir: string; name: string; display: string } {
	const slash = rawPrefix.lastIndexOf("/");
	const display = slash === -1 ? (rawPrefix.startsWith("./") ? "./" : "") : rawPrefix.slice(0, slash + 1);
	const dir = display.replace(/^\.\//, "").replace(/\/+$/, "");
	return { dir, name: slash === -1 ? rawPrefix : rawPrefix.slice(slash + 1), display };
}

export function pathItems(
	entries: readonly { name: string; dir: boolean }[],
	rawPrefix: string,
	options: { isAtPrefix: boolean; isQuotedPrefix: boolean },
): CompletionItem[] {
	const { name, display } = pathCompletion(rawPrefix);
	const lower = name.toLowerCase();
	return entries
		.filter((entry) => entry.name.toLowerCase().startsWith(lower))
		.toSorted((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
		.map((entry) => ({
			value: buildCompletionValue(`${display}${entry.name}${entry.dir ? "/" : ""}`, {
				isDirectory: entry.dir,
				isAtPrefix: options.isAtPrefix,
				isQuotedPrefix: options.isQuotedPrefix,
			}),
			label: entry.name + (entry.dir ? "/" : ""),
		}));
}

/**
 * pi-tui `applyCompletion` for file items: replaces `prefix` before the cursor with the item's value; files get a
 * trailing space after `@` items, directories none (completion continues), a closing quote is not doubled.
 */
export function applyFileCompletion(
	line: string,
	cursorCol: number,
	item: CompletionItem,
	prefix: string,
): { line: string; cursorCol: number } {
	const before = line.slice(0, cursorCol - prefix.length);
	const after = line.slice(cursorCol);
	const quoted = prefix.startsWith('"') || prefix.startsWith('@"');
	const rest = quoted && item.value.endsWith('"') && after.startsWith('"') ? after.slice(1) : after;
	const isDirectory = item.label.endsWith("/");
	const suffix = prefix.startsWith("@") && !isDirectory ? " " : "";
	const offset = isDirectory && item.value.endsWith('"') ? item.value.length - 1 : item.value.length;
	return { line: `${before}${item.value}${suffix}${rest}`, cursorCol: before.length + offset + suffix.length };
}
