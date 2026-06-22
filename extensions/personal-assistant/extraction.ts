import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { embedText, buildEmbeddableText, loadConfig } from "./embed.ts";
import { writeAtomToFile } from "./file-store.ts";
import { MemoryIndex } from "./storage.ts";
import type { MemoryAtom, ExtractionItem, ExtractionPlan, ExtractionResult } from "./types.ts";

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
// .passthrough() on items so unknown fields (e.g. "system": true hallucinated
// by some models) don't fail validation — we only use the 6 known fields.
export const extractionPlanSchema = z.object({
	items: z.array(z.object({
		type: z.enum(["rule", "fact", "process"]),
		title: z.string().min(1).max(200),
		content: z.string().min(10).max(5000),
		summary: z.string().min(5).max(500),
		tags: z.array(z.string().min(1).max(50)).max(10),
		importance: z.number().min(0).max(1),
	}).passthrough()).min(1).max(50),
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

// ---------------------------------------------------------------------------
// executePlan — execute extraction items against the memory index
// ---------------------------------------------------------------------------

/**
 * Execute a single extraction item against the index:
 *   - fingerprint dedup: skip when an active atom with the same fingerprint exists
 *   - cosine dedup: supersede when the most similar active atom clears 0.92
 *   - otherwise: create a new atom (DB row + vector + .md file)
 *
 * Returns the outcome (skip / supersede / create) and the resulting atom when
 * applicable. Embedding failures collapse to "create with zero-vector" so the
 * file write still happens — sqlite-vec accepts zero vectors and downstream
 * recall simply misses this atom until a real embedding lands.
 */
async function executeItem(
	index: MemoryIndex,
	atomsDir: string,
	item: ExtractionItem,
): Promise<{ status: "skip" | "supersede" | "create"; atom?: MemoryAtom }> {
	const fingerprint = computeFingerprint(item.content);

	// Fingerprint dedup — cheapest check first.
	const existing = index.getActiveAtomByFingerprint(fingerprint);
	if (existing) {
		return { status: "skip", atom: existing };
	}

	// Embed the full atom text (title + summary + content + tags).
	const fakeAtom = {
		title: item.title,
		summary: item.summary,
		content: item.content,
		tags: item.tags,
	} as Pick<MemoryAtom, "title" | "summary" | "content" | "tags">;
	const embeddableText = buildEmbeddableText(fakeAtom);
	const embedding = await embedText(embeddableText);

	// Cosine dedup — only when we actually got a vector.
	if (embedding) {
		const similar = index.findMostSimilarEmbedding(embedding, 0.92);
		if (similar) {
			const newAtom = buildAtomFromItem(item, fingerprint);
			const { newAtom: finalNew } = index.markSupersededTx(similar.atom.id, newAtom, embedding);
			await writeAtomToFile(finalNew, atomsDir);
			return { status: "supersede", atom: finalNew };
		}
	}

	// Create new atom.
	const newAtom = buildAtomFromItem(item, fingerprint);
	const vector = embedding ?? new Array(1024).fill(0);
	await index.insertAtom(newAtom, vector);
	await writeAtomToFile(newAtom, atomsDir);
	return { status: "create", atom: newAtom };
}

/**
 * Build a fresh `MemoryAtom` from an extraction item. All version-chain
 * fields default to "first version, active, no parent" — `markSupersededTx`
 * overrides these for the supersede path.
 */
function buildAtomFromItem(item: ExtractionItem, fingerprint: string): MemoryAtom {
	const now = Date.now();
	return {
		id: randomUUID(),
		type: item.type,
		title: item.title,
		content: item.content,
		summary: item.summary,
		tags: item.tags,
		importance: item.importance,
		strength: item.importance,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: now,
		updated_at: now,
		last_access: null,
		content_fingerprint: fingerprint,
		source_session: null,
	};
}

/**
 * Process every item in the plan sequentially and return three buckets:
 *   - created: new atoms written to DB + file
 *   - superseded: pairs of (oldId, newAtom) for atoms replaced by similar content
 *   - skipped: existing atoms that matched the fingerprint exactly
 *
 * Items are processed in order — the spec is sequential, not parallel.
 */
export async function executePlan(
	index: MemoryIndex,
	atomsDir: string,
	plan: ExtractionPlan,
): Promise<{
	created: MemoryAtom[];
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	const created: MemoryAtom[] = [];
	const superseded: Array<{ oldId: string; newAtom: MemoryAtom }> = [];
	const skipped: MemoryAtom[] = [];

	for (const planItem of plan.items) {
		const result = await executeItem(index, atomsDir, planItem.item);
		if (result.status === "create" && result.atom) {
			created.push(result.atom);
		} else if (result.status === "supersede" && result.atom) {
			superseded.push({ oldId: planItem.item.title, newAtom: result.atom });
		} else if (result.status === "skip" && result.atom) {
			skipped.push(result.atom);
		}
	}

	return { created, superseded, skipped };
}

/**
 * Safely parse LLM JSON output and validate it against the extraction schema.
 * Returns `null` for any failure — invalid JSON, missing required fields,
 * type mismatches. Callers should treat null as "no usable plan" and skip
 * the execution step rather than throw.
 */
export function parseExtractionJson(json: string): ExtractionResult | null {
	try {
		const parsed = JSON.parse(json);
		const result = extractionPlanSchema.safeParse(parsed);
		if (!result.success) return null;
		return result.data as ExtractionResult;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Phase 4.5: top-level extraction entry points
// ---------------------------------------------------------------------------

/**
 * Build the full prompt that gets sent to the LLM: instruction + the
 * conversation transcript. Kept as a pure function so it can be inspected in
 * tests without needing to mock the LLM.
 */
function buildExtractionPrompt(messages: Array<{ role: string; content: string }>): string {
	const messagesText = messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
	return `${EXTRACT_PROMPT_V2}\n\n## Messages\n\n${messagesText}\n\n## Output (JSON only)`;
}

/**
 * Placeholder bridge between the extraction pipeline and pi's active LLM
 * session. The actual implementation depends on the ExtensionContext API
 * surface (which exposes the session's model + a streaming completion
 * method), so until that integration lands we throw loudly rather than
 * silently emitting empty plans.
 *
 * Once the ExtensionContext shape is pinned down, this becomes a thin
 * adapter over `ctx.session.complete(prompt)`.
 */
async function callLlmViaContext(_ctx: ExtensionContext, _prompt: string): Promise<string> {
	throw new Error("callLlmViaContext: not implemented in this task — use callLlm version");
}

/**
 * Internal helper shared by both extraction entry points. Given a parsed
 * LLM response (or null on parse failure) and an execution context,
 * returns the plan + the buckets of atoms created/superseded/skipped.
 *
 * Writes the extraction report to the standard log directory as a side
 * effect so the audit trail captures every run, including the empty ones.
 */
async function executeParsedPlan(
	index: MemoryIndex,
	atomsDir: string,
	parsed: ExtractionResult | null,
	modelUsed: string,
): Promise<{
	plan: ExtractionPlan;
	created: MemoryAtom[];
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	if (!parsed) {
		return {
			plan: { items: [], modelUsed, generatedAt: Date.now() },
			created: [],
			superseded: [],
			skipped: [],
		};
	}

	const plan: ExtractionPlan = {
		items: parsed.items.map((item) => ({ item, status: "create" })),
		modelUsed,
		generatedAt: Date.now(),
	};

	const execResult = await executePlan(index, atomsDir, plan);
	await writeExtractionReport(plan);
	return { plan, ...execResult };
}

/**
 * Extract memories from a conversation transcript using the active pi
 * session's LLM (via the ExtensionContext). Used by pi itself when
 * running the extraction hook inline; webui uses the explicit-callLlm
 * variant instead because the LLM there is an HTTP handler, not a
 * session object.
 */
export async function extractMemories(
	messages: Array<{ role: string; content: string }>,
	index: MemoryIndex,
	ctx: ExtensionContext,
	config: { atomsDir: string; model?: string },
): Promise<{
	plan: ExtractionPlan;
	created: MemoryAtom[];
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	const prompt = buildExtractionPrompt(messages);
	const response = await callLlmViaContext(ctx, prompt);
	const parsed = parseExtractionJson(response);
	return executeParsedPlan(index, config.atomsDir, parsed, config.model ?? "unknown");
}

/**
 * Same pipeline as `extractMemories`, but the LLM is supplied as an
 * explicit `(prompt) => response` callback. Webui passes its HTTP-side
 * LLM call here; the index lifecycle stays in the caller's hands so this
 * function is reusable inside a longer-lived process.
 */
export async function extractMemoriesWithCallLlm(
	callLlm: (prompt: string) => Promise<string>,
	messages: Array<{ role: string; content: string }>,
	index: MemoryIndex,
	config: { atomsDir: string; model?: string },
): Promise<{
	plan: ExtractionPlan;
	created: MemoryAtom[];
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	const prompt = buildExtractionPrompt(messages);
	const response = await callLlm(prompt);
	const parsed = parseExtractionJson(response);
	return executeParsedPlan(index, config.atomsDir, parsed, config.model ?? "unknown");
}

/** Options for the webui entry point. Bundles everything the caller has to know. */
export interface RunMemoryExtractionOptions {
	callLlm: (prompt: string) => Promise<string>;
	config: { model?: string };
	messages: Array<{ role: string; content: string }>;
	dbPath: string;
	atomsDir: string;
}

/** Result bundle for the webui entry point. */
export interface RunMemoryExtractionResult {
	plan: ExtractionPlan;
	created: MemoryAtom[];
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}

/**
 * Webui-friendly entry point: open a fresh MemoryIndex, run the full
 * extraction pipeline, close the index. The whole call is wrapped in
 * try/finally so a downstream failure still releases the sqlite handle
 * — leaked file descriptors and lingering WAL checkpoints are both bad.
 */
export async function runMemoryExtraction(
	opts: RunMemoryExtractionOptions,
): Promise<RunMemoryExtractionResult> {
	const index = new MemoryIndex(opts.dbPath);
	await index.init();
	try {
		return await extractMemoriesWithCallLlm(opts.callLlm, opts.messages, index, {
			atomsDir: opts.atomsDir,
			model: opts.config.model,
		});
	} finally {
		index.close();
	}
}

/**
 * Persist a JSON report describing the extraction plan that just ran.
 * Defaults to `~/.pi/agent/logs/extraction-report-<timestamp>.json`;
 * callers (mostly tests) can override `logDir` to capture runs into a
 * temp directory. The directory is created recursively so first-run
 * installations do not need a pre-existing log directory.
 *
 * Returns the absolute file path so callers can surface it in UI / logs.
 */
export async function writeExtractionReport(plan: ExtractionPlan, logDir?: string): Promise<string> {
	const dir = logDir ?? join(homedir(), ".pi", "agent", "logs");
	await fs.mkdir(dir, { recursive: true });
	// Colons and dots are replaced because Windows / FAT32 file systems reject
	// them, and the iso timestamp uses both. We still keep enough granularity
	// for chronological ordering.
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const fp = join(dir, `extraction-report-${ts}.json`);
	const report = {
		plan,
		timestamp: new Date().toISOString(),
		itemCount: plan.items.length,
	};
	await fs.writeFile(fp, JSON.stringify(report, null, 2), "utf8");
	return fp;
}