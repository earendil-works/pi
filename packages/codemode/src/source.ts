/**
 * Codemode source format: JavaScript, optionally preceded by one options line.
 *
 * ```js
 * // @options {"timeout": 30}
 * const text = await tools.read({ path: "package.json" });
 * return JSON.parse(text).name;
 * ```
 */

/** Largest timeout `setTimeout` supports, in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const OPTIONS_LINE = /^[ \t]*\/\/ @options(?=[ \t{])(.*)$/;

/**
 * Lark grammar for providers with grammar-constrained tool input. It only fixes the shape of the
 * options line; the options JSON and the code are checked by {@link parseCodemodeSource}.
 */
export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @options[ \t]*\{[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export interface CodemodeSourceOptions {
	/** Deadline for the whole script in seconds, including tool calls. */
	timeout?: number;
}

export interface ParsedCodemodeSource {
	/** The script with the options line replaced by an empty line, so line numbers are unchanged. */
	code: string;
	options: CodemodeSourceOptions;
}

export class CodemodeSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeSourceError";
	}
}

function parseOptions(json: string): CodemodeSourceOptions {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new CodemodeSourceError(
			`@options must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodemodeSourceError("@options must be a JSON object");
	}
	const options: CodemodeSourceOptions = {};
	for (const [key, option] of Object.entries(value)) {
		if (key !== "timeout") throw new CodemodeSourceError(`Unknown @options key "${key}". Supported: timeout`);
		if (typeof option !== "number" || !Number.isFinite(option) || option <= 0 || option > MAX_TIMEOUT_SECONDS) {
			throw new CodemodeSourceError(
				`@options timeout must be a positive number of seconds up to ${MAX_TIMEOUT_SECONDS}`,
			);
		}
		options.timeout = option;
	}
	return options;
}

/** Split an optional first-line `// @options {...}` from the script. Throws {@link CodemodeSourceError}. */
export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	const newline = input.indexOf("\n");
	const firstLine = (newline === -1 ? input : input.slice(0, newline)).replace(/\r$/, "");
	const match = OPTIONS_LINE.exec(firstLine);
	if (!match) return { code: input, options: {} };
	const code = newline === -1 ? "" : input.slice(newline);
	if (code.trim() === "") throw new CodemodeSourceError("The @options line must be followed by code");
	return { code, options: parseOptions(match[1].trim()) };
}
