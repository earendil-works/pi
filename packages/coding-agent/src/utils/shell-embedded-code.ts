/**
 * Split a POSIX shell command into shell text and embedded code for display.
 *
 * Models often run scripts through the shell tool instead of writing files first:
 *
 *   cd repo && python3 - <<'EOF'
 *   print("hi")
 *   EOF
 *   node -e 'console.log(1)'
 *
 * Highlighting the whole command as shell renders the heredoc body and inline scripts as shell,
 * where a lone quote in the embedded code colors the rest of the command. This module finds
 * heredoc bodies and interpreter inline scripts (`-c`, `-e`, ...) and infers their language from
 * the command that consumes them, so each part can be highlighted on its own.
 *
 * The scanner is approximate and only used for display. It tracks quotes, command boundaries,
 * redirects, and `$(...)` nesting well enough for the commands models write, and never throws.
 */

export interface ShellSegment {
	/** Exact source text. Concatenating all segment texts yields the original command. */
	text: string;
	/** False for shell syntax, true for a heredoc body or inline script. */
	embedded: boolean;
	/** Highlight language for embedded code. Undefined for plain data such as a commit message. */
	language?: string;
}

export interface SplitShellCommandOptions {
	/** Resolve a highlight language from a file path, used for `cat > file <<'EOF'`. */
	languageFromPath?: (path: string) => string | undefined;
}

interface ShellCommand {
	words: string[];
	/** Word being built, or undefined between words. */
	word: string | undefined;
	/** Set while the next word is a redirect target. */
	pendingRedirect: { fd: string; dup: boolean } | undefined;
	/** Target of the last stdout redirect (`> file`, `>> file`, `&> file`). */
	stdoutTarget: string | undefined;
}

interface ShellFrame {
	kind: "shell";
	command: ShellCommand;
	/** Open parentheses inside this `$(...)` frame. */
	parenDepth: number;
	/** True for `$(...)`, `<(...)`, and `>(...)`, which end at the matching `)`. */
	substitution: boolean;
}

interface DoubleQuoteFrame {
	kind: "double";
}

type Frame = ShellFrame | DoubleQuoteFrame;

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	command: ShellCommand;
}

interface InterpreterSpec {
	language: string;
	/** Flag that introduces an inline script, e.g. `-c` or `-e`. */
	inlineFlag?: RegExp;
	/** The first positional argument is the script, as in `awk '{ print $1 }'`. */
	inlineFirstPositional?: boolean;
	/** Options whose value is the next word, e.g. `-r json` for ruby. */
	valueOptions?: ReadonlySet<string>;
	/** Stdin is code even when positional arguments are present, e.g. `psql mydb <<'SQL'`. */
	stdinAlwaysCode?: boolean;
}

const SHELL_INLINE_FLAG = /^-[A-Za-z]*c$/;
const NODE_INLINE_FLAG = /^(?:-[A-Za-z]*[ep]|--eval|--print)$/;

const PYTHON_SPEC: InterpreterSpec = {
	language: "python",
	inlineFlag: /^-[A-Za-z]*c$/,
	valueOptions: new Set(["-W", "-X", "-m"]),
};
const NODE_SPEC: InterpreterSpec = {
	language: "javascript",
	inlineFlag: NODE_INLINE_FLAG,
	valueOptions: new Set(["-r", "--require", "--import", "--loader", "--input-type", "--conditions", "-C"]),
};
const TYPESCRIPT_SPEC: InterpreterSpec = {
	language: "typescript",
	inlineFlag: NODE_INLINE_FLAG,
	valueOptions: NODE_SPEC.valueOptions,
};
const SHELL_SPEC: InterpreterSpec = {
	language: "bash",
	inlineFlag: SHELL_INLINE_FLAG,
	valueOptions: new Set(["-o", "+o", "-O", "+O"]),
};
const AWK_SPEC: InterpreterSpec = {
	language: "awk",
	inlineFirstPositional: true,
	valueOptions: new Set(["-F", "-v", "-f"]),
};

const INTERPRETERS: Record<string, InterpreterSpec> = {
	python: PYTHON_SPEC,
	pypy: PYTHON_SPEC,
	node: NODE_SPEC,
	bun: NODE_SPEC,
	tsx: TYPESCRIPT_SPEC,
	"ts-node": TYPESCRIPT_SPEC,
	ruby: { language: "ruby", inlineFlag: /^-[A-Za-z]*e$/, valueOptions: new Set(["-r", "-I"]) },
	perl: { language: "perl", inlineFlag: /^-[A-Za-z0-9]*[eE]$/, valueOptions: new Set(["-I", "-M", "-m"]) },
	php: { language: "php", inlineFlag: /^-r$/ },
	lua: { language: "lua", inlineFlag: /^-e$/ },
	swift: { language: "swift", inlineFlag: /^-e$/ },
	osascript: { language: "applescript", inlineFlag: /^-e$/, valueOptions: new Set(["-l"]) },
	sh: SHELL_SPEC,
	bash: SHELL_SPEC,
	zsh: SHELL_SPEC,
	dash: SHELL_SPEC,
	ksh: SHELL_SPEC,
	awk: AWK_SPEC,
	gawk: AWK_SPEC,
	mawk: AWK_SPEC,
	psql: {
		language: "sql",
		inlineFlag: /^(?:-c|--command)$/,
		valueOptions: new Set(["-d", "-h", "-p", "-U", "-f"]),
		stdinAlwaysCode: true,
	},
	mysql: {
		language: "sql",
		inlineFlag: /^(?:-e|--execute)$/,
		valueOptions: new Set(["-u", "-h", "-P", "-D"]),
		stdinAlwaysCode: true,
	},
	duckdb: { language: "sql", inlineFlag: /^-c$/, stdinAlwaysCode: true },
	sqlite3: { language: "sql", stdinAlwaysCode: true },
};

/** Heredoc delimiter names that state the body language, e.g. `node tool.js <<'JS'`. */
const DELIMITER_LANGUAGES: Record<string, string> = {
	PY: "python",
	PYTHON: "python",
	JS: "javascript",
	JAVASCRIPT: "javascript",
	NODE: "javascript",
	MJS: "javascript",
	TS: "typescript",
	TYPESCRIPT: "typescript",
	RB: "ruby",
	RUBY: "ruby",
	PL: "perl",
	PERL: "perl",
	PHP: "php",
	LUA: "lua",
	SWIFT: "swift",
	SQL: "sql",
	SH: "bash",
	BASH: "bash",
	ZSH: "bash",
	SHELL: "bash",
	JSON: "json",
	YAML: "yaml",
	YML: "yaml",
	TOML: "ini",
	HTML: "xml",
	XML: "xml",
	CSS: "css",
	RS: "rust",
	RUST: "rust",
	GO: "go",
	C: "c",
	CPP: "cpp",
	MD: "markdown",
	MARKDOWN: "markdown",
	DIFF: "diff",
	PATCH: "diff",
};

/** Words that precede the real command without changing what consumes stdin. */
const TRANSPARENT_WORDS = new Set([
	"sudo",
	"time",
	"nohup",
	"exec",
	"command",
	"builtin",
	"do",
	"then",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"!",
	"{",
]);

const UV_VALUE_OPTIONS = new Set([
	"--with",
	"--with-editable",
	"--with-requirements",
	"--python",
	"-p",
	"--project",
	"--directory",
	"--extra",
	"--group",
	"--env-file",
	"--package",
	"--index",
	"--from",
]);

const ENV_VALUE_OPTIONS = new Set(["-u", "-C", "-S"]);
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "-k", "-n", "--signal", "--kill-after"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function newCommand(): ShellCommand {
	return { words: [], word: undefined, pendingRedirect: undefined, stdoutTarget: undefined };
}

function skipOptions(words: string[], index: number, valueOptions?: ReadonlySet<string>): number {
	let i = index;
	while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
		if (words[i] === "--") return i + 1;
		if (valueOptions?.has(words[i])) i++;
		i++;
	}
	return i;
}

/** Strip assignments and wrappers such as `sudo` or `uv run --with x`, returning the program index. */
function findProgramIndex(words: string[]): number {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (ASSIGNMENT.test(word) || TRANSPARENT_WORDS.has(word)) {
			i++;
		} else if (word === "env") {
			i = skipOptions(words, i + 1, ENV_VALUE_OPTIONS);
			while (i < words.length && ASSIGNMENT.test(words[i])) i++;
		} else if (word === "timeout" || word === "nice") {
			i = skipOptions(words, i + 1, TIMEOUT_VALUE_OPTIONS);
			if (word === "timeout") i++;
		} else if (word === "uv" && words[i + 1] === "run") {
			i = skipOptions(words, i + 2, UV_VALUE_OPTIONS);
		} else if (word === "uv" && words[i + 1] === "tool" && words[i + 2] === "run") {
			i = skipOptions(words, i + 3, UV_VALUE_OPTIONS);
		} else if (word === "npx" || word === "bunx" || (word === "pnpm" && words[i + 1] === "exec")) {
			i = skipOptions(words, word === "pnpm" ? i + 2 : i + 1);
		} else {
			return i;
		}
	}
	return i;
}

function programName(word: string): string {
	const base = word.slice(word.lastIndexOf("/") + 1).replace(/\.exe$/i, "");
	if (/^python\d*(?:\.\d+)?$/.test(base) || /^pypy\d*$/.test(base)) return "python";
	return base;
}

/** `python -m pkg` hands all later arguments to the module, so `-c` is no longer Python's flag. */
function runsPythonModule(spec: InterpreterSpec, args: string[]): boolean {
	return spec === PYTHON_SPEC && args.some((arg) => arg.startsWith("-m"));
}

function substituteVariables(value: string, variables: ReadonlyMap<string, string>): string {
	return value.replace(
		/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
		(match, braced: string | undefined, bare: string | undefined) => variables.get(braced ?? bare ?? "") ?? match,
	);
}

/** Language of a heredoc body, from the command that reads it or the delimiter name. */
function heredocLanguage(
	heredoc: PendingHeredoc,
	variables: ReadonlyMap<string, string>,
	options: SplitShellCommandOptions,
): string | undefined {
	const words = heredoc.command.words;
	const programIndex = findProgramIndex(words);
	const program = programIndex < words.length ? programName(words[programIndex]) : undefined;
	const pathLanguage = (path: string | undefined) =>
		path ? options.languageFromPath?.(substituteVariables(path, variables)) : undefined;

	let language: string | undefined;
	if (program === "cat") {
		language = pathLanguage(heredoc.command.stdoutTarget);
	} else if (program === "tee") {
		const argsStart = skipOptions(words, programIndex + 1);
		language = pathLanguage(words[argsStart]) ?? pathLanguage(heredoc.command.stdoutTarget);
	} else if (program !== undefined) {
		const spec = INTERPRETERS[program];
		if (spec) {
			const positionalIndex = skipOptions(words, programIndex + 1, spec.valueOptions);
			const positional = words[positionalIndex];
			const readsScriptFromStdin = positional === undefined || positional === "-";
			const hasInlineScript = spec.inlineFlag
				? words.slice(programIndex + 1).some((word) => spec.inlineFlag?.test(word))
				: false;
			const runsModule = runsPythonModule(spec, words.slice(programIndex + 1));
			if (spec.stdinAlwaysCode || (readsScriptFromStdin && !hasInlineScript && !runsModule)) {
				language = spec.language;
			}
		}
	}
	return language ?? DELIMITER_LANGUAGES[heredoc.delimiter.toUpperCase()];
}

/**
 * Language of a quoted word that starts at the current position, if it is an interpreter's inline
 * script such as the argument of `python3 -c` or `node -e`. Returns undefined for regular words.
 */
function inlineScriptLanguage(command: ShellCommand): string | undefined {
	const words = command.words;
	const programIndex = findProgramIndex(words);
	if (programIndex >= words.length) return undefined;
	const spec = INTERPRETERS[programName(words[programIndex])];
	if (!spec) return undefined;
	const args = words.slice(programIndex + 1);
	// Options after a positional argument belong to a script, as in `python3 tool.py -c x`.
	if (skipOptions(args, 0, spec.valueOptions) !== args.length || runsPythonModule(spec, args)) return undefined;
	const previous = args[args.length - 1];
	if (spec.inlineFlag && previous !== undefined && spec.inlineFlag.test(previous)) return spec.language;
	if (spec.inlineFirstPositional) return spec.language;
	return undefined;
}

/** Split a shell command into shell text, heredoc bodies, and inline scripts. */
export function splitShellCommand(command: string, options: SplitShellCommandOptions = {}): ShellSegment[] {
	const segments: ShellSegment[] = [];
	const variables = new Map<string, string>();
	const frames: Frame[] = [{ kind: "shell", command: newCommand(), parenDepth: 0, substitution: false }];
	let pendingHeredocs: PendingHeredoc[] = [];
	let segmentStart = 0;
	let i = 0;

	const pushSegment = (end: number, embedded: boolean, language?: string) => {
		if (end <= segmentStart) return;
		const text = command.slice(segmentStart, end);
		const previous = segments[segments.length - 1];
		if (!embedded && previous && !previous.embedded) {
			previous.text += text;
		} else {
			segments.push(embedded ? { text, embedded, language } : { text, embedded });
		}
		segmentStart = end;
	};

	const shellFrame = (): ShellFrame => {
		for (let index = frames.length - 1; index >= 0; index--) {
			const frame = frames[index];
			if (frame.kind === "shell") return frame;
		}
		return frames[0] as ShellFrame;
	};

	const appendToWord = (text: string) => {
		const current = shellFrame().command;
		current.word = (current.word ?? "") + text;
	};

	const finishWord = (current: ShellCommand) => {
		if (current.word === undefined) return;
		const word = current.word;
		current.word = undefined;
		if (current.pendingRedirect) {
			const { fd, dup } = current.pendingRedirect;
			current.pendingRedirect = undefined;
			if (!dup && (fd === "1" || fd === "&")) current.stdoutTarget = word;
			return;
		}
		current.words.push(word);
	};

	const endCommand = (frame: ShellFrame) => {
		finishWord(frame.command);
		const words = frame.command.words;
		const assignments = words[0] === "export" ? words.slice(1) : words;
		if (assignments.length > 0 && assignments.every((word) => ASSIGNMENT.test(word))) {
			for (const word of assignments) {
				const eq = word.indexOf("=");
				variables.set(word.slice(0, eq), substituteVariables(word.slice(eq + 1), variables));
			}
		}
		frame.command = newCommand();
	};

	/** Consume heredoc bodies that start at `bodyStart`, returning the index after the last delimiter line. */
	const consumeHeredocs = (bodyStart: number): number => {
		let position = bodyStart;
		for (const heredoc of pendingHeredocs) {
			const language = heredocLanguage(heredoc, variables, options);
			pushSegment(position, false);
			let lineStart = position;
			let delimiterStart = -1;
			let delimiterEnd = command.length;
			while (lineStart < command.length) {
				const newline = command.indexOf("\n", lineStart);
				const lineEnd = newline === -1 ? command.length : newline;
				let line = command.slice(lineStart, lineEnd);
				if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
				// A delimiter on the last line of a streaming command may still be growing, but an
				// exact match is also how a complete command ends, so both cases are treated as closed.
				if (line === heredoc.delimiter) {
					delimiterStart = lineStart;
					delimiterEnd = newline === -1 ? command.length : newline + 1;
					break;
				}
				if (newline === -1) break;
				lineStart = newline + 1;
			}
			if (delimiterStart === -1) {
				pushSegment(command.length, true, language);
				pendingHeredocs = [];
				return command.length;
			}
			pushSegment(delimiterStart, true, language);
			position = delimiterEnd;
		}
		pendingHeredocs = [];
		return position;
	};

	/** Emit an inline script inside quotes that open at `quoteIndex` and close at `closeIndex`. */
	const emitInlineScript = (quoteIndex: number, closeIndex: number, language: string) => {
		pushSegment(quoteIndex + 1, false);
		pushSegment(closeIndex, true, language);
	};

	const findDoubleQuoteEnd = (start: number): number => {
		for (let index = start; index < command.length; index++) {
			const char = command[index];
			if (char === "\\") index++;
			else if (char === '"') return index;
		}
		return command.length;
	};

	while (i < command.length) {
		const frame = frames[frames.length - 1];
		const char = command[i];
		const next = command[i + 1];

		if (frame.kind === "double") {
			if (char === "\\") {
				appendToWord(next ?? "");
				i += 2;
			} else if (char === '"') {
				frames.pop();
				i++;
			} else if (char === "$" && next === "(" && command[i + 2] !== "(") {
				appendToWord("$()");
				frames.push({ kind: "shell", command: newCommand(), parenDepth: 0, substitution: true });
				i += 2;
			} else {
				appendToWord(char);
				i++;
			}
			continue;
		}

		const current = frame.command;
		switch (char) {
			case "\\": {
				if (next !== "\n") appendToWord(next ?? "");
				i += 2;
				break;
			}
			case "'": {
				const close = command.indexOf("'", i + 1);
				const end = close === -1 ? command.length : close;
				const language = current.word === undefined ? inlineScriptLanguage(current) : undefined;
				if (language) emitInlineScript(i, end, language);
				appendToWord(command.slice(i + 1, end));
				i = end + 1;
				break;
			}
			case '"': {
				const language = current.word === undefined ? inlineScriptLanguage(current) : undefined;
				if (language) {
					const end = findDoubleQuoteEnd(i + 1);
					emitInlineScript(i, end, language);
					appendToWord(command.slice(i + 1, end));
					i = end + 1;
				} else {
					appendToWord("");
					frames.push({ kind: "double" });
					i++;
				}
				break;
			}
			case "$": {
				if (next === "(" && command[i + 2] === "(") {
					// Arithmetic expansion: `<<` inside is a shift, not a heredoc.
					const close = command.indexOf("))", i + 3);
					const end = close === -1 ? command.length : close + 2;
					appendToWord(command.slice(i, end));
					i = end;
				} else if (next === "(") {
					appendToWord("$()");
					frames.push({ kind: "shell", command: newCommand(), parenDepth: 0, substitution: true });
					i += 2;
				} else {
					appendToWord(char);
					i++;
				}
				break;
			}
			case "#": {
				if (current.word !== undefined) {
					appendToWord(char);
					i++;
					break;
				}
				const newline = command.indexOf("\n", i);
				i = newline === -1 ? command.length : newline;
				break;
			}
			case " ":
			case "\t": {
				finishWord(current);
				i++;
				break;
			}
			case "\n": {
				endCommand(frame);
				i = pendingHeredocs.length > 0 ? consumeHeredocs(i + 1) : i + 1;
				break;
			}
			case ";":
			case "|": {
				endCommand(frame);
				i++;
				break;
			}
			case "&": {
				if (next === ">") {
					finishWord(current);
					current.pendingRedirect = { fd: "&", dup: false };
					i += command[i + 2] === ">" ? 3 : 2;
				} else {
					endCommand(frame);
					i++;
				}
				break;
			}
			case "(": {
				endCommand(frame);
				frame.parenDepth++;
				i++;
				break;
			}
			case ")": {
				endCommand(frame);
				if (frame.substitution && frame.parenDepth === 0) frames.pop();
				else frame.parenDepth = Math.max(0, frame.parenDepth - 1);
				i++;
				break;
			}
			case "<": {
				if (next === "(") {
					appendToWord("<()");
					frames.push({ kind: "shell", command: newCommand(), parenDepth: 0, substitution: true });
					i += 2;
					break;
				}
				finishWord(current);
				if (next !== "<") {
					current.pendingRedirect = { fd: "0", dup: false };
					i++;
					break;
				}
				if (command[i + 2] === "<") {
					// Here-string: the next word is data, not an argument.
					current.pendingRedirect = { fd: "0", dup: false };
					i += 3;
					break;
				}
				const match = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()'"]+))/.exec(command.slice(i));
				if (!match) {
					i += 2;
					break;
				}
				const delimiter = match[2] ?? match[3] ?? match[4] ?? "";
				// While streaming, the operator line may end before the delimiter is complete.
				const complete = i + match[0].length < command.length;
				if (delimiter && complete) {
					pendingHeredocs.push({ delimiter, stripTabs: match[1] === "-", command: current });
				}
				i += match[0].length;
				break;
			}
			case ">": {
				let fd = "1";
				if (current.word !== undefined && /^\d+$/.test(current.word)) {
					fd = current.word;
					current.word = undefined;
				} else {
					finishWord(current);
				}
				if (next === "(") {
					appendToWord(">()");
					frames.push({ kind: "shell", command: newCommand(), parenDepth: 0, substitution: true });
					i += 2;
					break;
				}
				i++;
				if (command[i] === ">" || command[i] === "|") i++;
				const dup = command[i] === "&";
				if (dup) i++;
				current.pendingRedirect = { fd, dup };
				break;
			}
			default: {
				appendToWord(char);
				i++;
			}
		}
	}

	pushSegment(command.length, false);
	return segments;
}
