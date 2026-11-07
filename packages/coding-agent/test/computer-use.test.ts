import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createApplyPatchToolDefinition, parseUnifiedDiff } from "../src/core/tools/apply-patch.ts";
import { COMPUTER_USE_PROMPT_YAML } from "../src/core/tools/computer-use-prompt.ts";
import { createScreenshotToolDefinition } from "../src/core/tools/screenshot.ts";

describe("computer use prompts", () => {
	test("elite YAML keeps mid-complex scope and banned minor triggers", () => {
		expect(COMPUTER_USE_PROMPT_YAML).toContain("mid_complex_only");
		expect(COMPUTER_USE_PROMPT_YAML).toContain("landing_page_rebuild_from_scratch");
		expect(COMPUTER_USE_PROMPT_YAML).toContain("minor_frontend_tweak");
		expect(COMPUTER_USE_PROMPT_YAML).toContain("multi_shot_validation: required");
	});
});

describe("screenshot tool", () => {
	test("definition uses strict constrained sampling and Pi-only guidelines", () => {
		const def = createScreenshotToolDefinition("/workspace");
		expect(def.name).toBe("screenshot");
		expect(def.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		expect(def.promptSnippet).toBe("Capture a screenshot (macOS; mid-complex work only)");
		expect(def.promptGuidelines?.join("\n")).toContain("mid-to-complex");
	});

	test("captures via injected operations to the requested path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-shot-"));
		const captured: string[] = [];
		const def = createScreenshotToolDefinition(dir, {
			operations: {
				capture: async (p) => {
					captured.push(p);
					writeFileSync(p, "pngbytes");
				},
			},
		});
		const result = await def.execute("id", { path: "shot.png" } as never);
		expect(captured[0]).toBe(join(dir, "shot.png"));
		expect(result.content[0]).toMatchObject({ type: "text" });
	});
});

describe("apply_patch tool", () => {
	test("parses a single-file hunk", () => {
		const files = parseUnifiedDiff(
			["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n"),
		);
		expect(files).toHaveLength(1);
		expect(files[0]?.path).toBe("a.txt");
		expect(files[0]?.hunks[0]?.lines).toEqual([
			{ kind: "context", text: "a" },
			{ kind: "delete", text: "b" },
			{ kind: "add", text: "B" },
			{ kind: "context", text: "c" },
		]);
	});

	test("applies exactly and fails on mismatch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-apply-patch-"));
		const file = join(dir, "a.txt");
		writeFileSync(file, "a\nb\nc\n");
		const def = createApplyPatchToolDefinition(dir);
		const ok = await def.execute("id", {
			patch: ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n"),
		});
		expect(ok.content[0]).toMatchObject({ type: "text" });
		await expect(
			def.execute("id", { patch: ["--- a/a.txt", "+++ b/a.txt", "@@ -1,1 +1,1 @@", " NOPE"].join("\n") }),
		).rejects.toThrowError(/does not match/);
	});
});

describe("default prompt is untouched", () => {
	test("default prompt still starts with the original prefix", async () => {
		const { buildSystemPrompt } = await import("../src/core/system-prompt.ts");
		const prompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [], contextFiles: [], skills: [] });
		expect(prompt.startsWith("You are a coding assistant running inside pi, a coding agent harness.")).toBe(true);
	});
});
