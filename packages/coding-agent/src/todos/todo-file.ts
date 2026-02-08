import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type TodoStatus = "open" | "in_progress" | "done" | "cancelled";

export interface TodoFrontmatter {
	/** File-stable identifier. Used as the filename: <id>.md */
	id: string;
	/** Short human-facing label. */
	title: string;
	/** Primary list/project name. */
	list: string;
	/** Optional cross-cutting labels. */
	tags?: string[];
	status: TodoStatus;
	created_at: string;
	updated_at: string;
	assigned_to_session?: string;
	assigned_to_run?: string;
}

export interface TodoFile {
	frontmatter: TodoFrontmatter;
	/** Markdown body (verbatim). Leading newline is preserved if present. */
	body: string;
}

export interface ParseTodoMarkdownResult {
	frontmatter: unknown;
	body: string;
}

const FRONTMATTER_OPEN = /^---\r?\n/;

/**
 * Best-effort front-matter parser.
 * - If content does not start with ---\n, returns null.
 * - If it starts with ---\n but has no closing fence, throws.
 */
export function parseFrontmatterMarkdown(markdown: string): ParseTodoMarkdownResult | null {
	if (!FRONTMATTER_OPEN.test(markdown)) {
		return null;
	}

	const yamlStart = markdown.match(FRONTMATTER_OPEN)?.[0].length ?? 4;

	// Find a closing fence that starts on its own line.
	// We search from after the opening fence to avoid matching the opening itself.
	const closeMatch = /\r?\n---\r?\n/.exec(markdown.slice(yamlStart));
	if (!closeMatch) {
		throw new Error("Invalid todo file: missing closing front-matter fence");
	}
	const closingIndex = yamlStart + closeMatch.index;
	const closingLen = closeMatch[0].length;

	// markdown structure: "---\n" + yaml + "\n---\n" + body
	// We want just the YAML segment (without the opening fence), but including trailing newline.
	const yamlText = markdown.slice(yamlStart, closingIndex + 1);
	const bodyStart = closingIndex + closingLen;
	const body = markdown.slice(bodyStart);

	const frontmatter = parseYaml(yamlText);
	return { frontmatter, body };
}

export function parseTodoMarkdownOrThrow(markdown: string): TodoFile {
	const parsed = parseFrontmatterMarkdown(markdown);
	if (!parsed) {
		throw new Error("Invalid todo file: missing YAML front-matter");
	}

	// Runtime validation happens in the store/tool layer; this module only parses/serializes.
	return {
		frontmatter: parsed.frontmatter as TodoFrontmatter,
		body: parsed.body,
	};
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const v of value) {
		if (typeof v === "string") out.push(v);
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Coerce unknown YAML data into a TodoFrontmatter shape.
 * This is intentionally strict: if required fields are missing, it throws.
 */
export function coerceTodoFrontmatter(value: unknown): TodoFrontmatter {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid todo file: front-matter is not an object");
	}

	const v = value as Record<string, unknown>;
	const id = typeof v.id === "string" ? v.id : "";
	const title = typeof v.title === "string" ? v.title : "";
	const list = typeof v.list === "string" ? v.list : "";
	const status = v.status as TodoStatus;
	const created_at = typeof v.created_at === "string" ? v.created_at : "";
	const updated_at = typeof v.updated_at === "string" ? v.updated_at : "";

	if (!id.trim()) throw new Error("Invalid todo file: missing id");
	if (!title.trim()) throw new Error("Invalid todo file: missing title");
	if (!list.trim()) throw new Error("Invalid todo file: missing list");
	if (status !== "open" && status !== "in_progress" && status !== "done" && status !== "cancelled") {
		throw new Error(`Invalid todo file: invalid status: ${String(v.status)}`);
	}
	if (!created_at.trim()) throw new Error("Invalid todo file: missing created_at");
	if (!updated_at.trim()) throw new Error("Invalid todo file: missing updated_at");

	return {
		id,
		title,
		list,
		tags: normalizeStringArray(v.tags),
		status,
		created_at,
		updated_at,
		assigned_to_session: typeof v.assigned_to_session === "string" ? v.assigned_to_session : undefined,
		assigned_to_run: typeof v.assigned_to_run === "string" ? v.assigned_to_run : undefined,
	};
}

export function formatTodoMarkdown(todo: TodoFile): string {
	// Construct an ordered object so YAML stringify output is stable/readable.
	const fm: Record<string, unknown> = {
		id: todo.frontmatter.id,
		title: todo.frontmatter.title,
		list: todo.frontmatter.list,
	};

	if (todo.frontmatter.tags && todo.frontmatter.tags.length > 0) {
		fm.tags = todo.frontmatter.tags;
	}

	fm.status = todo.frontmatter.status;
	fm.created_at = todo.frontmatter.created_at;
	fm.updated_at = todo.frontmatter.updated_at;

	if (todo.frontmatter.assigned_to_session) {
		fm.assigned_to_session = todo.frontmatter.assigned_to_session;
	}
	if (todo.frontmatter.assigned_to_run) {
		fm.assigned_to_run = todo.frontmatter.assigned_to_run;
	}

	const yamlBody = stringifyYaml(fm).trimEnd();
	return `---\n${yamlBody}\n---\n${todo.body ?? ""}`;
}
