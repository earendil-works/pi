// Converts find tool path globs to fd regexes that accept both Windows path separators.

const SEP = String.raw`[/\\]`;
const NOT_SEP = String.raw`[^/\\]`;

/**
 * Convert a glob path pattern ('/'-separated, with `*`, `?`, `**`, `[...]`, and `{a,b}`) into an
 * anchored regex for `fd --full-path` whose separators match both `/` and `\`.
 *
 * fd before 10.5.1 matched --full-path globs against paths with native `\` separators on Windows,
 * so globs containing `/` never matched (sharkdp/fd#2067). Rewriting the glob's `/` into `[/\\]`
 * worked around that but breaks every path glob on fd 10.5.1, where `**[/\\]` is no longer a
 * recursive wildcard. fd's regex mode matches native paths on every version, so on Windows pi
 * matches path patterns through a regex it builds itself.
 */
export function globToFullPathRegex(pattern: string): string {
	const components = splitTopLevel(pattern, "/");
	let regex = "";
	let needsSeparator = false;
	for (let i = 0; i < components.length; i++) {
		const component = components[i];
		const prefix = needsSeparator ? SEP : "";
		if (component === "**") {
			// A whole '**' component matches any number of directories, including none.
			regex += i === components.length - 1 ? `${prefix}.*` : `${prefix}(?:.*${SEP})?`;
			needsSeparator = false;
		} else {
			regex += prefix + convertSegment(component);
			needsSeparator = true;
		}
	}
	return `^${regex}$`;
}

/** Split on `separator` outside braces and character classes. */
function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "[") {
			const end = findClassEnd(text, i);
			if (end !== -1) i = end;
		} else if (char === "{") {
			depth++;
		} else if (char === "}" && depth > 0) {
			depth--;
		} else if (char === separator && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

/** Index of the `]` closing the class that opens at `start`, or -1 when it is not closed. */
function findClassEnd(text: string, start: number): number {
	let i = start + 1;
	if (text[i] === "!" || text[i] === "^") i++;
	// A leading ']' is a literal member of the class.
	if (text[i] === "]") i++;
	return text.indexOf("]", i);
}

function convertSegment(segment: string): string {
	let regex = "";
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i];
		if (char === "*") {
			// '**' inside a component (for example 'a**b') matches like '*'.
			while (segment[i + 1] === "*") i++;
			regex += `${NOT_SEP}*`;
		} else if (char === "?") {
			regex += NOT_SEP;
		} else if (char === "/") {
			// Only reachable inside braces, for example '{src/a,lib}'.
			regex += SEP;
		} else if (char === "[" && findClassEnd(segment, i) !== -1) {
			const end = findClassEnd(segment, i);
			regex += convertClass(segment.slice(i + 1, end));
			i = end;
		} else if (char === "{" && findBraceEnd(segment, i) !== -1) {
			const end = findBraceEnd(segment, i);
			const alternatives = splitTopLevel(segment.slice(i + 1, end), ",");
			regex += `(?:${alternatives.map(convertSegment).join("|")})`;
			i = end;
		} else {
			regex += escapeRegexChar(char);
		}
	}
	return regex;
}

/** Index of the `}` matching the `{` at `start`, or -1 when it is not closed. */
function findBraceEnd(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (char === "[") {
			const end = findClassEnd(text, i);
			if (end !== -1) i = end;
		} else if (char === "{") {
			depth++;
		} else if (char === "}" && --depth === 0) {
			return i;
		}
	}
	return -1;
}

function convertClass(body: string): string {
	const negated = body.startsWith("!") || body.startsWith("^");
	const members = negated ? body.slice(1) : body;
	let regex = "";
	for (let i = 0; i < members.length; i++) {
		const char = members[i];
		// '-' between two members is a range; anywhere else it is literal.
		if (char === "-" && i > 0 && i < members.length - 1) {
			regex += "-";
		} else {
			// Escape characters that are special inside Rust regex classes, including the set
			// operators '&&', '--', and '~~'.
			regex += /[\\[\]^&~-]/.test(char) ? `\\${char}` : char;
		}
	}
	// Like globs, classes never match a path separator.
	return negated ? String.raw`[^/\\${regex}]` : `[${regex}]`;
}

function escapeRegexChar(char: string): string {
	return /[\\.+*?()|[\]{}^$]/.test(char) ? `\\${char}` : char;
}
