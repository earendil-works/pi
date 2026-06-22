import { describe, it, expect } from "vitest";
import { extractionPlanSchema, EXTRACT_PROMPT_V2 } from "../extraction.ts";

describe("EXTRACT_PROMPT_V2", () => {
	it("contains 3 atom type names", () => {
		expect(EXTRACT_PROMPT_V2).toContain("rule");
		expect(EXTRACT_PROMPT_V2).toContain("fact");
		expect(EXTRACT_PROMPT_V2).toContain("process");
	});

	it("specifies 2-4 段 content format", () => {
		expect(EXTRACT_PROMPT_V2).toContain("2-4 段");
	});

	it("instructs NOT to emit skip/merge markers (dedup auto)", () => {
		expect(EXTRACT_PROMPT_V2).toMatch(/dedup.*自动|自动.*dedup/i);
	});

	it("specifies JSON output schema", () => {
		expect(EXTRACT_PROMPT_V2).toContain('"items"');
		expect(EXTRACT_PROMPT_V2).toContain('"type"');
		expect(EXTRACT_PROMPT_V2).toContain('"content"');
	});
});

describe("extractionPlanSchema", () => {
	it("accepts valid plan with all 3 types", () => {
		const validPlan = {
			items: [
				{
					type: "rule" as const,
					title: "测试 rule",
					content: "用户偏好 TypeScript strict mode。\n所有 .ts 文件必须 noImplicitAny。",
					summary: "TS strict 偏好",
					tags: ["typescript", "preference"],
					importance: 0.7,
				},
				{
					type: "fact" as const,
					title: "PDF library",
					content: "PDF 提取用 pymupdf 而不是 pdfplumber。",
					summary: "PDF 库选择",
					tags: ["pdf"],
					importance: 0.5,
				},
				{
					type: "process" as const,
					title: "Cron 多步",
					content: "Step 1\nStep 2\nStep 3",
					summary: "多步 cron",
					tags: ["cron"],
					importance: 0.6,
				},
			],
		};
		const result = extractionPlanSchema.safeParse(validPlan);
		expect(result.success).toBe(true);
	});

	it("rejects invalid type (not in 3-type enum)", () => {
		const result = extractionPlanSchema.safeParse({
			items: [{
				type: "constraint",
				title: "t",
				content: "long enough content",
				summary: "summary text",
				tags: [],
				importance: 0.5,
			}],
		});
		expect(result.success).toBe(false);
	});

	it("rejects empty items array", () => {
		const result = extractionPlanSchema.safeParse({ items: [] });
		expect(result.success).toBe(false);
	});

	it("rejects content too short", () => {
		const result = extractionPlanSchema.safeParse({
			items: [{
				type: "rule",
				title: "t",
				content: "short",
				summary: "long enough summary",
				tags: [],
				importance: 0.5,
			}],
		});
		expect(result.success).toBe(false);
	});

	it("rejects importance out of range", () => {
		const result = extractionPlanSchema.safeParse({
			items: [{
				type: "rule",
				title: "t",
				content: "long enough content",
				summary: "long enough summary",
				tags: [],
				importance: 1.5,
			}],
		});
		expect(result.success).toBe(false);
	});

	it("rejects too many tags (>10)", () => {
		const result = extractionPlanSchema.safeParse({
			items: [{
				type: "rule",
				title: "t",
				content: "long enough content",
				summary: "long enough summary",
				tags: new Array(20).fill("tag"),
				importance: 0.5,
			}],
		});
		expect(result.success).toBe(false);
	});
});