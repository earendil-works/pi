// Prompt templates and skill invocation, copied from earendil-works/pi (MIT, see third-party/pi.LICENSE):
// coding-agent core/prompt-templates.ts (parseCommandArgs, substituteArgs, the template file format and
// expandPromptTemplate), utils/frontmatter.ts, and core/agent-session.ts (`_expandSkillCommand`, `parseSkillBlock`).
// No filesystem here: files are read by the caller through the session's environment.
import { parse } from "yaml";

export type PromptTemplate = {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	/** Where it came from: p2's data directory (`global`) or the project's `.pi/prompts`. */
	source: "global" | "project";
	path: string;
};
export type SkillFile = {
	name: string;
	description: string;
	/** The `SKILL.md` path in the session's environment; its directory is the base for relative references. */
	path: string;
	baseDir: string;
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** pi's `parseFrontmatter`: YAML between leading `---` lines, the rest is the body (trimmed). */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = normalizeNewlines(content.replace(/^\uFEFF/, ""));
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: normalized };
	const parsed: unknown = parse(normalized.slice(4, end));
	return {
		frontmatter:
			parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {},
		body: normalized.slice(end + 4).trim(),
	};
}

/** pi's template file: name from the file, `description` (or the first line, 60 characters) and `argument-hint`. */
export function parseTemplate(
	fileName: string,
	content: string,
	source: PromptTemplate["source"],
	path: string,
): PromptTemplate {
	const { frontmatter, body } = parseFrontmatter(content);
	const name = fileName.replace(/\.md$/, "");
	let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description) {
		const firstLine = body.split("\n").find((line) => line.trim());
		if (firstLine) description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
	}
	const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;
	return { name, description, ...(argumentHint ? { argumentHint } : {}), content: body, source, path };
}

/** Bash-style argument splitting with quotes (pi's `parseCommandArgs`). */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	for (const char of argsString) {
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") inQuote = char;
		else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else current += char;
	}
	if (current) args.push(current);
	return args;
}

/**
 * pi's `substituteArgs`: `$1`…, `$@`/`$ARGUMENTS`, `${N:-default}`, `${@:-default}`/`${ARGUMENTS:-default}`,
 * `${@:N}` and `${@:N:L}`. Values are not substituted again.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS"
						? allArgs
						: args[Number.parseInt(defaultTarget, 10) - 1];
				return value ? value : defaultValue;
			}
			if (sliceStart) {
				const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
				return sliceLength
					? args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ")
					: args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number.parseInt(simple, 10) - 1] ?? "";
		},
	);
}

/** pi's skill block: the skill's body with its name and location, then the user's arguments. */
export function skillBlock(skill: SkillFile, fileContent: string, args: string): string {
	const body = parseFrontmatter(fileContent).body.trim();
	const block = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}

/**
 * pi's order: `/skill:name args` becomes the skill block, then `/name args` the first template of that name (global
 * before project). Anything else, unknown names and unreadable skills stay as typed.
 */
export async function expandPrompt(
	text: string,
	templates: readonly PromptTemplate[],
	skills: readonly SkillFile[],
	readSkill: (skill: SkillFile) => Promise<string | undefined>,
): Promise<{ text: string; skill?: { name: string } }> {
	if (text.startsWith("/skill:")) {
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(7) : text.slice(7, space);
		const args = space === -1 ? "" : text.slice(space + 1).trim();
		const skill = skills.find((entry) => entry.name === name);
		if (!skill) return { text };
		const content = await readSkill(skill).catch(() => undefined);
		return content === undefined ? { text } : { text: skillBlock(skill, content, args), skill: { name } };
	}
	if (!text.startsWith("/")) return { text };
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	const template = match ? templates.find((entry) => entry.name === match[1]) : undefined;
	if (!template) return { text };
	return { text: substituteArgs(template.content, parseCommandArgs(match?.[2] ?? "")) };
}
