import { createHash } from "node:crypto";
import { z } from "zod";

// normalizeContent: strip extra whitespace, trim, lowercase
export function normalizeContent(content: string): string {
	return content
		.replace(/\s+/g, " ") // collapse all whitespace (newlines, tabs, spaces) to single space
		.trim()
		.toLowerCase();
}

// computeFingerprint: sha256 of normalized content, first 16 chars
export function computeFingerprint(content: string): string {
	return createHash("sha256").update(normalizeContent(content)).digest("hex").slice(0, 16);
}

// extractionPlanSchema: validate LLM JSON output
export const extractionPlanSchema = z.object({
	items: z.array(z.object({
		type: z.enum(["rule", "fact", "process"]),
		title: z.string().min(1).max(200),
		content: z.string().min(10).max(5000),
		summary: z.string().min(5).max(500),
		tags: z.array(z.string().min(1).max(50)).max(10),
		importance: z.number().min(0).max(1),
	})).min(1).max(50),
});

// Type inferred from schema
export type ExtractionPlanInput = z.infer<typeof extractionPlanSchema>;

// EXTRACT_PROMPT_V2: instruction to LLM (Chinese, per project convention)
export const EXTRACT_PROMPT_V2 = `你是一个 memory extraction agent。从对话中提取值得持久化的知识为 atom。

## Atom 类型 (3 类)

1. **rule**: 用户的偏好/约束/规则 (跨 session 适用)
   - 例: "用户偏好 TypeScript strict mode", "commit 前必须跑 check"
   - 特征: "should/must/不要/总是/从不要"

2. **fact**: 客观事实/状态/事件 (会话内或近期)
   - 例: "PDF 提取用 pymupdf", "图片导出格式选 CMYK"
   - 特征: 可验证, 有具体细节

3. **process**: 多步工作流/经验/解决方案 (可复用步骤)
   - 例: "Cron 多步执行", "PDF → 图片 → 报告"
   - 特征: 步骤化, 含 if-then 或 sequence

## Content 格式 (2-4 段)

- 每段一句话, 用 \\n 分隔
- 总长 50-500 字 (太长会被截断)
- 含具体细节 (参数/路径/命令), 不要抽象描述
- 引用原子事实 (如 "用 bge-m3 不是 bge-large")

## Tags

- 3-8 个, 短小 (1-3 词), 含中英文
- 例: ["pdf", "image extraction", "PyMuPDF"]

## Importance

- 0-1 浮点, 默认 0.5
- 高频引用 + 难复现 → 0.8-1.0
- 一次性细节 → 0.2-0.4

## Dedup 策略 (重要!)

代码会自动处理 dedup, 你不需要担心:
- 内容指纹 (sha256) → 完全重复跳过
- 余弦相似度 > 0.92 → 旧 atom 自动 superseded

所以你只管 emit, 不需要 emit "skip" 或 "merge" 类标记。

## Output Schema (严格 JSON)

返回纯 JSON, 不要 markdown 代码块包装:
{
  "items": [
    {
      "type": "rule" | "fact" | "process",
      "title": "短标题 (≤ 50 字)",
      "content": "2-4 段正文, 用 \\\\n 分隔",
      "summary": "1-2 句摘要",
      "tags": ["tag1", "tag2"],
      "importance": 0.5
    }
  ]
}

如果没有可提取的, 返回 { "items": [] }
`;