import { homedir } from "node:os";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "../../coding-agent/src/core/system-prompt.ts";
import {
	applyIsolatedEnvironment,
	createPiDocumentationEvalHarness,
	DOCUMENTATION_EVAL_TOOLS,
	excludePiDocumentation,
	resolveDocumentationVariant,
	resolveModelSelection,
} from "../src/harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults", () => {
		expect(resolveModelSelection(undefined, { PI_PROVIDER: " openai-codex ", PI_MODEL: " gpt-5.6-sol " })).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([{}, { PI_PROVIDER: "openai-codex" }, { PI_MODEL: "gpt-5.6-sol" }])(
		"rejects incomplete model selection",
		(environment) => {
			expect(() => resolveModelSelection(undefined, environment)).toThrow("Select a harness model explicitly");
		},
	);
});

describe("isolateProcessEnvironment", () => {
	it("removes runner metadata and restores the process environment", () => {
		vi.stubEnv("PI_EVAL_VARIANT", "with_docs");
		vi.stubEnv("PI_EVAL_ARTIFACT_DIR", "/tmp/artifacts");
		const oldHome = process.env.HOME;
		try {
			const restore = applyIsolatedEnvironment("/tmp/eval-home", "/tmp/eval-agent");
			try {
				expect(homedir()).toBe("/tmp/eval-home");
				expect(process.env.PI_CODING_AGENT_DIR).toBe("/tmp/eval-agent");
				expect(process.env.PI_EVAL_VARIANT).toBeUndefined();
				expect(process.env.PI_EVAL_ARTIFACT_DIR).toBeUndefined();
			} finally {
				restore();
			}
			expect(process.env.HOME).toBe(oldHome);
			expect(process.env.PI_EVAL_VARIANT).toBe("with_docs");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("documentation variant", () => {
	it.each(["without_docs", "with_docs"] as const)("accepts %s", (variant) => {
		expect(resolveDocumentationVariant(variant)).toBe(variant);
	});

	it.each([undefined, "", "other"])("rejects invalid variant %s", (variant) => {
		expect(() => resolveDocumentationVariant(variant)).toThrow("PI_EVAL_VARIANT");
	});

	it("strips only the documentation routing section from the default Pi prompt", () => {
		const prompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [...DOCUMENTATION_EVAL_TOOLS],
		});
		expect(prompt).toContain("\nPi documentation (read only");
		expect(prompt).toContain("\nGuidelines:\n");
		expect(prompt).toContain("\nCurrent working directory: /workspace");
		expect(prompt).toContain("docs/models.md");

		const stripped = excludePiDocumentation(prompt);
		expect(stripped).toContain("\nGuidelines:\n");
		expect(stripped).toContain("\nCurrent working directory: /workspace");
		expect(stripped).not.toContain("Pi documentation");
		expect(stripped).not.toContain("docs/models.md");
		expect(stripped).not.toContain(getReadmePath());
		expect(stripped).not.toContain(getDocsPath());
		expect(stripped).not.toContain(getExamplesPath());
	});

	it("fails closed when prompt markers are missing", () => {
		expect(() => excludePiDocumentation("Instructions")).toThrow("no Pi documentation section");
		expect(() => excludePiDocumentation("\nPi documentation (read only\n")).toThrow("no working-directory section");
	});

	it("rejects documentation harnesses outside the container sandbox", () => {
		expect(() => createPiDocumentationEvalHarness()).toThrow("isolated container sandbox");
	});
});
