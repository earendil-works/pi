import { stripFrontmatter } from "../utils/frontmatter.ts";
import { type PromptTemplate, parseCommandArgs, substituteArgs } from "./prompt-templates.ts";
import type { Skill } from "./skills.ts";

/**
 * Mid-sentence invocation of skills and prompt templates.
 *
 * `/skill:name args` and `/template args` only expand at the start of the input
 * (line 1). This module extends the same expansion to `/name args` tokens
 * anywhere from line 2 on, replacing the token in place.
 *
 * Semantics:
 * - Word boundary: the slash must be preceded by whitespace or a newline, so
 *   paths and ratios (`C:/x`, `a/b`, `n/d`, `km/h`) never trigger.
 * - The start of the input is native territory: when the text begins with a
 *   slash, the whole first line is skipped (line-1 commands like
 *   `/skill:name` consume it). Mid-line tokens on the first line expand:
 *   `hello /name args` is not a line-1 command, so nothing else would expand
 *   it.
 * - The name is `[A-Za-z0-9][A-Za-z0-9_-]*` (2+ chars) and must end at a
 *   boundary. A colon right after the name (e.g. `/skill:foo`) stays literal.
 * - Args run to the end of the line (exclusive); text after the newline is
 *   preserved. A token followed by another token candidate on the same line
 *   expands bare (its args would otherwise swallow the sibling invocation).
 * - Name resolution tries prompt templates first (on a name collision the
 *   template wins), then skills. Each registry resolves exact match, then a
 *   unique case-insensitive variant, then a unique prefix.
 * - Skill output is byte-identical to the native `/skill:name` expansion;
 *   template output is identical to the native line-1 expansion.
 * - Fail-soft: unresolvable names and unreadable files stay literal.
 * - Single pass: the output is never rescanned, so expansions cannot recurse.
 */

/** Candidate token name after a whitespace-preceded slash. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*/;

/** A later ` /name` candidate on the same line marks a token as a list member. */
const NEXT_TOKEN_RE = /\s\/[A-Za-z0-9]/;

export interface ExpandMidsentenceRegistries {
	skills: Skill[];
	templates: PromptTemplate[];
}

export interface ExpandMidsentenceDeps {
	/** Skill file reader (injected to keep this module pure and testable). */
	readSkillFile: (filePath: string) => string;
}

/**
 * Build the inline skill invocation (block + args), identical to the native
 * `/skill:name args` expansion.
 */
export function buildSkillInvocation(skill: Skill, rawContent: string, args: string): string {
	const body = stripFrontmatter(rawContent).trim();
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	return args ? `${skillBlock}\n\n${args}` : skillBlock;
}

/**
 * Resolve a typed name against a registry: exact match, then a unique
 * case-insensitive variant, then a unique prefix. Ambiguous or missing stays
 * unresolved.
 */
function resolveUnique<T>(items: T[], getName: (item: T) => string, typed: string): T | undefined {
	const exact = items.find((item) => getName(item) === typed);
	if (exact) return exact;

	const lower = typed.toLowerCase();
	const caseVariants = items.filter((item) => getName(item).toLowerCase() === lower);
	if (caseVariants.length === 1) return caseVariants[0];

	const prefixed = items.filter((item) => getName(item).startsWith(typed));
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

function resolveAndExpand(
	name: string,
	args: string,
	registries: ExpandMidsentenceRegistries,
	deps: ExpandMidsentenceDeps,
): string | undefined {
	// Templates first: on a name collision the template wins.
	const template = resolveUnique(registries.templates, (t) => t.name, name);
	if (template) {
		return substituteArgs(template.content, parseCommandArgs(args));
	}

	const skill = resolveUnique(registries.skills, (s) => s.name, name);
	if (skill) {
		try {
			return buildSkillInvocation(skill, deps.readSkillFile(skill.filePath), args);
		} catch {
			return undefined; // Fail-soft: unreadable file stays literal
		}
	}

	return undefined;
}

/**
 * Expand every mid-sentence `/name args` token (skill or prompt template) in a
 * single pass, in position order. The start of the input stays native.
 */
export function expandMidsentence(
	text: string,
	registries: ExpandMidsentenceRegistries,
	deps: ExpandMidsentenceDeps,
): string {
	let i = 0;
	let out = "";

	while (true) {
		const slash = text.indexOf("/", i);
		if (slash === -1) {
			out += text.slice(i);
			break;
		}

		// Absolute start of input is native: a slash at position 0 begins a
		// line-1 command, which consumes the whole first line.
		if (slash === 0) {
			const nl = text.search(/[\n\r]/);
			const stop = nl === -1 ? text.length : nl;
			out += text.slice(0, stop);
			i = stop;
			continue;
		}

		// Word boundary: the character before the slash must be whitespace.
		if (!/\s/.test(text[slash - 1]!)) {
			out += text.slice(i, slash + 1);
			i = slash + 1;
			continue;
		}

		const candidate = NAME_RE.exec(text.slice(slash + 1));
		if (!candidate || candidate[0].length < 2) {
			out += text.slice(i, slash + 1);
			i = slash + 1;
			continue;
		}

		const name = candidate[0];
		const afterName = slash + 1 + name.length;
		const nextCh = text[afterName] ?? "";

		// The name must end at a boundary.
		if (nextCh && /[A-Za-z0-9_-]/.test(nextCh)) {
			out += text.slice(i, slash + 1);
			i = slash + 1;
			continue;
		}

		// Namespace guard: `/name:...` (e.g. `/skill:foo`) is not a sigil.
		if (nextCh === ":") {
			out += text.slice(i, slash + 1);
			i = slash + 1;
			continue;
		}

		// Args run to the end of the line (exclusive), unless a sibling token
		// candidate follows on the same line (then this token expands bare).
		let args = "";
		let end = afterName;
		if (nextCh && /\s/.test(nextCh)) {
			const relNl = text.slice(afterName).search(/[\n\r]/);
			const lineEnd = relNl === -1 ? text.length : afterName + relNl;
			if (!NEXT_TOKEN_RE.test(text.slice(afterName, lineEnd))) {
				args = text.slice(afterName, lineEnd).trim();
				end = lineEnd;
			}
		}

		const replacement = resolveAndExpand(name, args, registries, deps);
		if (replacement === undefined) {
			out += text.slice(i, afterName);
			i = afterName;
			continue;
		}

		out += text.slice(i, slash) + replacement;
		i = end;
	}

	return out;
}
