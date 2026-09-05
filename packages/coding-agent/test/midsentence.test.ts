/**
 * Unit tests for mid-sentence skill/prompt-template expansion
 * (`expandMidsentence` in src/core/midsentence.ts).
 */

import { describe, expect, test } from "vitest";
import { buildSkillInvocation, expandMidsentence } from "../src/core/midsentence.ts";
import type { PromptTemplate } from "../src/core/prompt-templates.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

function makeSkill(overrides?: Partial<Skill>): Skill {
	return {
		name: "verify-build",
		description: "Verify the build",
		filePath: "/skills/verify-build/SKILL.md",
		baseDir: "/skills/verify-build",
		sourceInfo: createSyntheticSourceInfo("/skills/verify-build/SKILL.md", { source: "local", baseDir: "/skills" }),
		disableModelInvocation: false,
		...overrides,
	};
}

function makeTemplate(overrides?: Partial<PromptTemplate>): PromptTemplate {
	return {
		name: "review",
		description: "Review the diff",
		content: "Review this: $ARGUMENTS",
		sourceInfo: createSyntheticSourceInfo("/prompts/review.md", { source: "local", baseDir: "/prompts" }),
		filePath: "/prompts/review.md",
		...overrides,
	};
}

function readerFor(map: Record<string, string>): (filePath: string) => string {
	return (filePath) => {
		const content = map[filePath];
		if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
		return content;
	};
}

const SKILL_MD = `---
name: verify-build
description: Verify the build
---

Run the full build checks.`;

function expand(
	text: string,
	skills: Skill[] = [],
	templates: PromptTemplate[] = [],
	reader = readerFor({ "/skills/verify-build/SKILL.md": SKILL_MD }),
) {
	return expandMidsentence(text, { skills, templates }, { readSkillFile: reader });
}

describe("expandMidsentence", () => {
	describe("trigger and non-trigger", () => {
		test("expands a skill token from line 2 on", () => {
			const skill = makeSkill();
			const out = expand("please run\n/verify-build now", [skill]);
			expect(out).toBe(`please run\n${buildSkillInvocation(skill, SKILL_MD, "now")}`);
		});

		test("expands a token mid-line when preceded by whitespace", () => {
			const skill = makeSkill();
			const out = expand("header\ncan you run /verify-build on this branch", [skill]);
			expect(out).toBe(`header\ncan you run ${buildSkillInvocation(skill, SKILL_MD, "on this branch")}`);
		});

		test("does not trigger on paths and ratios (no whitespace before slash)", () => {
			const skill = makeSkill();
			const text = "look at C:/x and a/b, n/d and 24/7 and km/h please";
			expect(expand(text, [skill])).toBe(text);
			expect(expand(`header\n${text}`, [skill])).toBe(`header\n${text}`);
		});

		test("position 0 is native: line-1 commands stay untouched", () => {
			const skill = makeSkill();
			const text = "/verify-build now\nand /summarize";
			expect(expand(text, [skill])).toBe(text);
		});

		test("mid-line token on the first line expands (not a line-1 command)", () => {
			const skill = makeSkill();
			const out = expand("run /verify-build now\nand summarize", [skill]);
			expect(out).toBe(`run ${buildSkillInvocation(skill, SKILL_MD, "now")}\nand summarize`);
		});

		test("single-line input starting with a slash stays native", () => {
			const skill = makeSkill();
			expect(expand("/verify-build now", [skill])).toBe("/verify-build now");
		});

		test("plain text without tokens passes through unchanged", () => {
			const skill = makeSkill();
			expect(expand("plain text", [skill])).toBe("plain text");
		});

		test("first-line /skill: and /template commands stay exactly as they are", () => {
			const template = makeTemplate();
			const text = "/review the diff\nthen /verify-build it";
			expect(expand(text, [makeSkill()], [template])).toBe(
				`/review the diff\nthen ${buildSkillInvocation(makeSkill(), SKILL_MD, "it")}`,
			);
		});
	});

	describe("args and multiline", () => {
		test("args run to end of line; text after the newline is preserved", () => {
			const skill = makeSkill();
			const out = expand("h\n/verify-build these args\nrest stays", [skill]);
			expect(out).toBe(`h\n${buildSkillInvocation(skill, SKILL_MD, "these args")}\nrest stays`);
		});

		test("token followed by non-whitespace (e.g. punctuation) expands bare", () => {
			const skill = makeSkill();
			const out = expand("h\n(see /verify-build, then report)", [skill]);
			expect(out).toBe(`h\n(see ${buildSkillInvocation(skill, SKILL_MD, "")}, then report)`);
		});

		test("multiline skill bodies keep their newlines", () => {
			const skill = makeSkill();
			const out = expand("h\n/verify-build\nnext line", [skill]);
			expect(out).toBe(
				`h\n<skill name="verify-build" location="/skills/verify-build/SKILL.md">\nReferences are relative to /skills/verify-build.\n\nRun the full build checks.\n</skill>\nnext line`,
			);
		});
	});

	describe("multiple tokens", () => {
		test("same line: earlier tokens expand bare when a sibling token follows", () => {
			const a = makeSkill();
			const b = makeSkill({
				name: "summarize",
				filePath: "/skills/summarize/SKILL.md",
				baseDir: "/skills/summarize",
			});
			const reader = readerFor({
				"/skills/verify-build/SKILL.md": SKILL_MD,
				"/skills/summarize/SKILL.md": "---\nname: summarize\ndescription: Summarize\n---\nSum it up.",
			});
			const out = expandMidsentence(
				"h\n/verify-build /summarize quickly",
				{ skills: [a, b], templates: [] },
				{ readSkillFile: reader },
			);
			expect(out).toBe(
				`h\n${buildSkillInvocation(a, SKILL_MD, "")} ${buildSkillInvocation(b, "---\nname: summarize\ndescription: Summarize\n---\nSum it up.", "quickly")}`,
			);
		});

		test("different lines: all expand in position order", () => {
			const a = makeSkill();
			const template = makeTemplate();
			const out = expand("h\nfirst /review the code\nthen /verify-build\nend", [a], [template]);
			expect(out).toBe(`h\nfirst Review this: the code\nthen ${buildSkillInvocation(a, SKILL_MD, "")}\nend`);
		});

		test("a non-sibling slash later on the line does not make args disappear", () => {
			const skill = makeSkill();
			// `1/2` has no whitespace before the slash: not a sibling candidate
			const out = expand("h\n/verify-build scale 1/2", [skill]);
			expect(out).toBe(`h\n${buildSkillInvocation(skill, SKILL_MD, "scale 1/2")}`);
		});
	});

	describe("name resolution ladder", () => {
		test("exact match wins over case variants and prefixes", () => {
			const exact = makeSkill();
			const other = makeSkill({
				name: "verify-build-fast",
				filePath: "/skills/fast/SKILL.md",
				baseDir: "/skills/fast",
			});
			const out = expand("h\n/verify-build go", [exact, other]);
			expect(out).toBe(`h\n${buildSkillInvocation(exact, SKILL_MD, "go")}`);
		});

		test("unique case-insensitive variant resolves", () => {
			const skill = makeSkill();
			const out = expand("h\n/VERIFY-BUILD go", [skill]);
			expect(out).toBe(`h\n${buildSkillInvocation(skill, SKILL_MD, "go")}`);
		});

		test("unique prefix resolves", () => {
			const skill = makeSkill();
			const out = expand("h\n/verify go", [skill]);
			expect(out).toBe(`h\n${buildSkillInvocation(skill, SKILL_MD, "go")}`);
		});

		test("ambiguous prefix stays literal", () => {
			const a = makeSkill();
			const b = makeSkill({ name: "verify-tests", filePath: "/skills/t/SKILL.md", baseDir: "/skills/t" });
			const text = "h\n/verify go";
			expect(expand(text, [a, b])).toBe(text);
		});

		test("ambiguous case variants stay literal", () => {
			const a = makeSkill();
			const b = makeSkill({ name: "Verify-Build", filePath: "/skills/v/SKILL.md", baseDir: "/skills/v" });
			const text = "h\n/VERIFY-BUILD go";
			expect(expand(text, [a, b])).toBe(text);
		});

		test("template/skill name collision: the template wins", () => {
			const template = makeTemplate({ name: "verify-build", content: "T: $ARGUMENTS" });
			const skill = makeSkill();
			const out = expand("h\n/verify-build now", [skill], [template]);
			expect(out).toBe("h\nT: now");
		});

		test("skill resolves when no template matches the typed name", () => {
			const template = makeTemplate({ name: "review" });
			const skill = makeSkill();
			const out = expand("h\n/verify-build now", [skill], [template]);
			expect(out).toBe(`h\n${buildSkillInvocation(skill, SKILL_MD, "now")}`);
		});
	});

	describe("guards", () => {
		test("colon after the name stays literal (/skill:foo mid-sentence)", () => {
			const text = "h\nrun /skill:foo bar";
			expect(expand(text, [makeSkill()])).toBe(text);
		});

		test("longer name does not match a shorter skill (name must end at boundary)", () => {
			const skill = makeSkill();
			const text = "h\n/verify-buildx now";
			expect(expand(text, [skill])).toBe(text);
		});

		test("single-character names never trigger", () => {
			const text = "h\n/a and /b";
			expect(expand(text, [makeSkill()])).toBe(text);
		});
	});

	describe("fail-soft and recursion", () => {
		test("unresolvable name stays literal, silently", () => {
			const text = "h\nrun /nope now";
			expect(expand(text, [makeSkill()])).toBe(text);
		});

		test("unreadable skill file stays literal", () => {
			const skill = makeSkill();
			const text = "h\n/verify-build now";
			expect(expand(text, [skill], [], readerFor({}))).toBe(text);
		});

		test("expanded bodies are never rescanned (no recursion)", () => {
			const skill = makeSkill();
			const recursive = makeSkill({
				name: "self-echo",
				filePath: "/skills/self/SKILL.md",
				baseDir: "/skills/self",
			});
			const reader = readerFor({
				"/skills/verify-build/SKILL.md":
					"---\nname: verify-build\ndescription: d\n---\nAlso run /self-echo please.",
				"/skills/self/SKILL.md": "---\nname: self-echo\ndescription: d\n---\nEcho.",
			});
			const out = expandMidsentence(
				"h\n/verify-build",
				{ skills: [skill, recursive], templates: [] },
				{ readSkillFile: reader },
			);
			expect(out).toContain("/self-echo please."); // literal inside the expanded body
			expect(out).not.toContain('<skill name="self-echo"');
		});

		test("skills with disable-model-invocation expand mid-sentence", () => {
			const skill = makeSkill({ disableModelInvocation: true });
			const out = expand("h\n/verify-build now", [skill]);
			expect(out).toBe(`h\n${buildSkillInvocation(skill, SKILL_MD, "now")}`);
		});
	});

	describe("templates", () => {
		test("expands with argument substitution identical to line-1 native behavior", () => {
			const template = makeTemplate({ content: "Do $1 then $2" });
			expect(expand("h\n/review alpha beta", [], [template])).toBe("h\nDo alpha then beta");
		});

		test("args without placeholders are dropped exactly like line-1 expansion", () => {
			const template = makeTemplate({ content: "No placeholders" });
			expect(expand("h\n/review extra words", [], [template])).toBe("h\nNo placeholders");
		});

		test("quoted args parse like the native command", () => {
			const template = makeTemplate({ content: "Do $1 and $2" });
			expect(expand(`h\n/review "two words" single`, [], [template])).toBe("h\nDo two words and single");
		});
	});
});

describe("buildSkillInvocation matches the native /skill: expansion", () => {
	test("byte-identical block shape with and without args", () => {
		expect(buildSkillInvocation(makeSkill(), SKILL_MD, "extra")).toBe(
			`<skill name="verify-build" location="/skills/verify-build/SKILL.md">\nReferences are relative to /skills/verify-build.\n\nRun the full build checks.\n</skill>\n\nextra`,
		);
		expect(buildSkillInvocation(makeSkill(), SKILL_MD, "")).toBe(
			`<skill name="verify-build" location="/skills/verify-build/SKILL.md">\nReferences are relative to /skills/verify-build.\n\nRun the full build checks.\n</skill>`,
		);
	});
});
