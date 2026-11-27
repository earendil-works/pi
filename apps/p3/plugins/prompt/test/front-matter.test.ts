// pi's front-matter reader as copied (`front-matter.ts`): the YAML between a first `---` line and the next as fields,
// the rest the body, trimmed; a BOM and Windows or old Mac line ends read as `\n`; no front matter, or no closing
// line: no fields and the whole text as the body; front matter that is no map: no fields; YAML that does not parse
// throws, as in pi.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter } from "../front-matter.ts";

describe("pi's front-matter reader", () => {
	it("reads the fields between the --- lines and the body after them, trimmed", () => {
		assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: >\n  b\n  c\n---\n\n# Body\n\n"), {
			frontmatter: { name: "a", description: "b c\n" },
			body: "# Body",
		});
	});

	it("reads a BOM and Windows or old Mac line ends as plain lines", () => {
		assert.deepEqual(parseFrontmatter("\uFEFF---\r\nname: a\r---\r\nbody"), {
			frontmatter: { name: "a" },
			body: "body",
		});
	});

	it("has no fields without front matter, without its closing line, or for front matter that is no map", () => {
		assert.deepEqual(parseFrontmatter("# Just text\n"), { frontmatter: {}, body: "# Just text\n" });
		assert.deepEqual(parseFrontmatter("---\nname: a\n"), { frontmatter: {}, body: "---\nname: a\n" });
		assert.deepEqual(parseFrontmatter("---\njust words\n---\nbody"), { frontmatter: {}, body: "body" });
	});

	it("throws for YAML that does not parse", () => {
		assert.throws(() => parseFrontmatter("---\ndescription: [unclosed\n---\n"));
	});
});
