import { describe, it, expect } from "vitest";
import { extractionPlanSchema, EXTRACT_PROMPT_V2, scoreUserTone, buildExtractionPrompt } from "../extraction.ts";

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

describe("scoreUserTone", () => {
	it('(a) "千万记得每次 commit 前跑 check" → STRONG (importanceHint 0.85)', () => {
		const messages = [{ role: "user", content: "千万记得每次 commit 前跑 check" }];
		expect(scoreUserTone(messages)).toEqual({ level: "strong", importanceHint: 0.85 });
	});

	it('(b) "我总是 9 点起床" → HABIT (importanceHint 0.65)', () => {
		const messages = [{ role: "user", content: "我总是 9 点起床" }];
		expect(scoreUserTone(messages)).toEqual({ level: "habit", importanceHint: 0.65 });
	});

	it('(c) "也许可以试试 bge-m3" → WEAK (importanceHint 0.35)', () => {
		const messages = [{ role: "user", content: "也许可以试试 bge-m3" }];
		expect(scoreUserTone(messages)).toEqual({ level: "weak", importanceHint: 0.35 });
	});

	it('(d) "如果今天有空就帮我看下 bug" → WEAK (importanceHint 0.35) — "如果" hits', () => {
		const messages = [{ role: "user", content: "如果今天有空就帮我看下 bug" }];
		expect(scoreUserTone(messages)).toEqual({ level: "weak", importanceHint: 0.35 });
	});

	it('(e) "今天天气不错" → NEUTRAL (importanceHint 0.5)', () => {
		const messages = [{ role: "user", content: "今天天气不错" }];
		expect(scoreUserTone(messages)).toEqual({ level: "neutral", importanceHint: 0.5 });
	});

	it('(f) "我有时候会看看文档" → RARE (importanceHint 0.2) — "有时" hits', () => {
		const messages = [{ role: "user", content: "我有时候会看看文档" }];
		expect(scoreUserTone(messages)).toEqual({ level: "rare", importanceHint: 0.2 });
	});

	it("tone scoring aggregates across messages — STRONG wins over WEAK", () => {
		const messages = [
			{ role: "user", content: "今天先这样" },
			{ role: "user", content: "明天千万记得帮我看下 bug" },
			{ role: "user", content: "如果不出问题就算了" },
		];
		expect(scoreUserTone(messages)).toEqual({ level: "strong", importanceHint: 0.85 });
	});
});

describe("buildExtractionPrompt tone injection", () => {
	it("(a) NEUTRAL messages: prompt does NOT contain <user_tone>", () => {
		const messages = [{ role: "user", content: "今天天气不错" }];
		const prompt = buildExtractionPrompt(messages);
		// The prompt docs mention `<user_tone>` and `<importance_hint>` as backtick-wrapped
		// examples, so a naive toContain() check would always hit. We assert that no actual
		// closed-form tone block is injected: no `<user_tone>X</user_tone>` for any tier.
		expect(prompt).not.toMatch(/<user_tone>(strong|habit|weak|rare)<\/user_tone>/);
		expect(prompt).not.toMatch(/<importance_hint>0\.\d+<\/importance_hint>/);
	});

	it("(b) STRONG messages: prompt contains <user_tone>strong</user_tone> AND <importance_hint>0.85</importance_hint>", () => {
		const messages = [{ role: "user", content: "千万记得每次 commit 前跑 check" }];
		const prompt = buildExtractionPrompt(messages);
		expect(prompt).toContain("<user_tone>strong</user_tone>");
		expect(prompt).toContain("<importance_hint>0.85</importance_hint>");
	});

	it("(c) HABIT messages: prompt contains <user_tone>habit</user_tone> AND <importance_hint>0.65</importance_hint>", () => {
		const messages = [{ role: "user", content: "我总是 9 点起床" }];
		const prompt = buildExtractionPrompt(messages);
		expect(prompt).toContain("<user_tone>habit</user_tone>");
		expect(prompt).toContain("<importance_hint>0.65</importance_hint>");
	});

	it("(d) WEAK messages: prompt contains <user_tone>weak</user_tone> AND <importance_hint>0.35</importance_hint>", () => {
		const messages = [{ role: "user", content: "也许可以试试 bge-m3" }];
		const prompt = buildExtractionPrompt(messages);
		expect(prompt).toContain("<user_tone>weak</user_tone>");
		expect(prompt).toContain("<importance_hint>0.35</importance_hint>");
	});

	it("(e) RARE messages: prompt contains <user_tone>rare</user_tone> AND <importance_hint>0.2</importance_hint>", () => {
		const messages = [{ role: "user", content: "我有时候会看看文档" }];
		const prompt = buildExtractionPrompt(messages);
		expect(prompt).toContain("<user_tone>rare</user_tone>");
		expect(prompt).toContain("<importance_hint>0.2</importance_hint>");
	});

	it("(f) EXTRACT_PROMPT_V2 documents the importance hint (search for ±0.15 or 可上下浮动)", () => {
		expect(EXTRACT_PROMPT_V2).toMatch(/±0\.15|可上下浮动/);
	});
});

describe("buildExtractionPrompt tagVocabulary injection", () => {
	it("(a) non-empty tagVocabulary: prompt contains '## 现有 tag 字典' section + dict entries joined with comma, between EXTRACT_PROMPT_V2 and ## Messages", () => {
		const messages = [{ role: "user", content: "16S amplicon 测序流程" }];
		const prompt = buildExtractionPrompt(messages, { tagVocabulary: ["amplicon", "16S"] });
		expect(prompt).toContain("## 现有 tag 字典");
		expect(prompt).toContain("amplicon, 16S");
		// Insertion order contract: EXTRACT_PROMPT_V2 → tagDictSection → ## Messages
		expect(prompt.indexOf(EXTRACT_PROMPT_V2)).toBeLessThan(prompt.indexOf("## 现有 tag 字典"));
		expect(prompt.indexOf("## 现有 tag 字典")).toBeLessThan(prompt.indexOf("## Messages"));
	});

	it("(b) tagVocabulary = [] (empty array): prompt does NOT contain '## 现有 tag 字典' section (avoid LLM noise)", () => {
		const messages = [{ role: "user", content: "今天天气不错" }];
		const prompt = buildExtractionPrompt(messages, { tagVocabulary: [] });
		expect(prompt).not.toContain("## 现有 tag 字典");
	});

	it("(c) opts undefined / opts = {} / opts.tagVocabulary undefined: prompt byte-identical to no-opts call (backward compat)", () => {
		const messages = [{ role: "user", content: "今天天气不错" }];
		const promptNoOpts = buildExtractionPrompt(messages);
		const promptEmptyOpts = buildExtractionPrompt(messages, {});
		const promptUndefinedVocab = buildExtractionPrompt(messages, { tagVocabulary: undefined });
		// No spurious dictionary section in any of these variants.
		expect(promptNoOpts).not.toContain("## 现有 tag 字典");
		expect(promptEmptyOpts).not.toContain("## 现有 tag 字典");
		expect(promptUndefinedVocab).not.toContain("## 现有 tag 字典");
		// Byte-identical regression guard.
		expect(promptEmptyOpts).toBe(promptNoOpts);
		expect(promptUndefinedVocab).toBe(promptNoOpts);
	});
});
