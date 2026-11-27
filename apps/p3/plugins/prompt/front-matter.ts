// pi's front-matter reader, copied from packages/coding-agent/src/utils/frontmatter.ts (`parseFrontmatter`, with
// `stripBom` of packages/coding-agent/src/utils/text.ts): YAML between a first line `---` and the next `\n---`, the
// rest the body. p3 does not depend on the coding agent; with the same reader a `SKILL.md` reads the same in pi, p2
// and p3. YAML that does not parse throws, as in pi. Its YAML parser is pi's (`yaml`), through p3's server API.

import { parseYaml as parse } from "@earendil-works/p3/v1/server";

/** A file's front matter (its fields; none: `{}`) and its body, trimmed. */
export type ParsedFrontmatter = { readonly frontmatter: Readonly<Record<string, unknown>>; readonly body: string };

/** `content`'s front matter and body, as pi's `parseFrontmatter` reads them; throws for YAML that does not parse. */
export function parseFrontmatter(content: string): ParsedFrontmatter {
	const { yamlString, body } = extractFrontmatter(content);
	if (yamlString === null) return { frontmatter: {}, body };
	const parsed: unknown = parse(yamlString);
	// A file people write (a trust boundary): front matter that is no map has no fields (pi reads its fields as absent).
	const frontmatter = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	return { frontmatter, body };
}

/** The YAML between the `---` lines (none: `null`) and the body after them, newlines normalized. */
function extractFrontmatter(content: string): { yamlString: string | null; body: string } {
	const normalized = (content.startsWith("\uFEFF") ? content.slice(1) : content)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { yamlString: null, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { yamlString: null, body: normalized };
	return { yamlString: normalized.slice(4, endIndex), body: normalized.slice(endIndex + 4).trim() };
}
