import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { embedText, buildEmbeddableText } from "./embed.ts";
import { writeAtomToFile } from "./file-store.ts";
// supersedeIfSimilar (dedup.ts) is intentionally NOT imported here — that
// helper still exists for webui PATCH path, but the extract pipeline no
// longer falls back to its cosine gate. update / create decisions are made
// solely by the Phase-1 LLM via oldId (or omission).
import { MemoryIndex } from "./storage.ts";
import { normalizeTag, conceptTagCount } from "./tag-vocab.ts";
// confirmDedupAction + DEDUP_CONFIRM_PROMPT (extraction-dedup-confirm.ts)
// are intentionally NOT imported here. The Phase-2 LLM 二次确认 pass no
// longer runs; the Phase-1 LLM is the sole decision-maker via oldId.
import { reindexOne } from "./bge-reindex.ts";
import { recallAtoms } from "./search.ts";
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
		// Optional update reference: when present, marks this item as a
		// merge into the atom with the given id (in-place update). When
		// omitted, behaves as a fresh create.
		oldId: z.string().uuid().optional(),
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

## User Tone Hint

如果用户消息携带 \`<user_tone>\` 和 \`<importance_hint>\` 段,这表示用户语气的强度暗示。LLM 应基于此**调整 importance**,但仍可上下浮动 ±0.15 — 这是 hint,不是 hardcode。

## Dedup 策略 (重要!)

- 内容指纹 (sha256) → 完全重复跳过 (代码侧自动, 你不需要管)
- 你负责 update vs create 的语义决策 (见下)

不再走 LLM 二次确认或余弦 gate:你的 oldId 字段是唯一的 update 引用方式。

## 主动更新,非扩张 (重要!)

- 如果新信息可归入 corpus 已有的 atom (主题/对象/项目相同), 在该 item 上设 oldId 为原子的 id,content 字段填合并后的内容(原 content 末尾追加新段落, 标注日期 e.g. "2026-07 新增 JSON 格式支持")
- 仅在信息属于全新主题/新对象/新项目时才创建新 atom(省略 oldId)
- 不要为同一段信息既 update 又 create;无法归属时倾向于 create

## 已有知识库 (重要! 不要重复提取已有知识)

下面列出 recall top-K 高相关召回的 atom (按相关度排序)。每条带 id / summary / content 截断预览 / .md 路径。
- 你只能看到 top-K 召回,其它 atom 也存在但不在此列出 — 看不到的不一定意味着新建
- 若你认为新信息可归入某条, 用其 id 填 oldId,系统就地更新;若确认是全新主题, 省略 oldId

## Output Schema (严格 JSON)

返回纯 JSON, 不要 markdown 代码块包装:
{
  "items": [
    {
      "oldId": "<uuid>",            // 可选;存在时 = update 该原子 (合并 content)
      // (omitted oldId = create 新 atom)
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
// Test-only access to executeItem
// ---------------------------------------------------------------------------
//
// `executeItem` is module-private so the public surface stays narrow.
// (No test-only alias is exported — the integration surface is
// `executePlan`, and older tests that reached for the alias via
// `extraction-dedup-confirm.test.ts` were retired when the dedup LLM
// confirm path was removed.)

// ---------------------------------------------------------------------------
// executePlan — execute extraction items against the memory index
// ---------------------------------------------------------------------------

/**
 * Trigger the bge-m3 service to recompute the dense+sparse vectors for an
 * atom after a write. Never throws — `reindexOne` already collapses every
 * failure mode to `{ok: false, error}`. We log a warning so a network blip
 * is visible in the run log without aborting the extract pipeline. The
 * worst case is one stale vector until the next reindex triggers; this is
 * an explicit trade-off (R3 / design Decision 4).
 */
async function reindexOneOrWarn(atomId: string): Promise<void> {
	const result = await reindexOne(atomId);
	if (!result.ok) {
		console.warn(`[extract] bge-m3 reindex failed for ${atomId}: ${result.error}`);
	}
}

/**
 * Persist a "create" outcome: insert the new atom + vector, write the file,
 * trigger bge-m3 to refresh the vector. Centralises the 3-line finalisation
 * that every create path (no oldId, unknown oldId fallback) goes through.
 */
async function persistCreate(
	index: MemoryIndex,
	atomsDir: string,
	newAtom: MemoryAtom,
	vector: number[],
): Promise<MemoryAtom> {
	await index.insertAtom(newAtom, vector);
	await writeAtomToFile(newAtom, atomsDir);
	await reindexOneOrWarn(newAtom.id);
	return newAtom;
}

/**
 * Execute a single extraction item against the index:
 *   1. fingerprint dedup: skip when an active atom with the same fingerprint
 *      exists (cheapest check, runs first).
 *   2. tag normalization + concept-tag presence check (R10).
 *   3. update path: when item.oldId is present and points to an existing
 *      active atom, rewrite that atom in place with the new content.
 *      When item.oldId is set but the atom cannot be found, warn-log and
 *      fall through to create (the LLM may have guessed an id; we don't
 *      want a hard fail).
 *   4. create path: insertAtom + writeAtomToFile + bge-m3 reindex.
 *
 * The LLM in Phase 1 is the sole decision-maker (no cosine gate, no LLM
 * 二次确认). When it emits oldId, we trust the id explicitly; when it
 * omits oldId, we trust it means "fresh create". Both branches end
 * with `reindexOneOrWarn` so the dense channel stays in sync.
 *
 * Returns the outcome (skip / update / create) and the resulting atom.
 * Embedding failures collapse to "create with zero-vector" so the file
 * write still happens — sqlite-vec accepts zero vectors and downstream
 * recall simply misses this atom until a real embedding lands.
 */
async function executeItem(
	index: MemoryIndex,
	atomsDir: string,
	item: ExtractionItem & { oldId?: string },
	_callLlm?: (prompt: string) => Promise<string>,
): Promise<{ status: "skip" | "update" | "create"; atom?: MemoryAtom }> {
	const fingerprint = computeFingerprint(item.content);

	// 1. Fingerprint dedup — cheapest check first.
	const existing = index.getActiveAtomByFingerprint(fingerprint);
	if (existing) {
		return { status: "skip", atom: existing };
	}

	// 2. Tag normalization + concept-tag presence check.
	const normalizedTags = item.tags.map((t) => normalizeTag(t));
	const conceptCount = conceptTagCount(normalizedTags);
	if (conceptCount === 0) {
		console.warn(
			`[extract] item "${item.title}" lacks concept tag (0/${normalizedTags.length} tags are concept/*)`,
		);
	}
	const itemWithNormTags = { ...item, tags: normalizedTags };

	// 3. Update path by oldId — no second-pass LLM confirm.
	if (itemWithNormTags.oldId) {
		const target = index.getAtom(itemWithNormTags.oldId);
		if (target && target.is_latest === 1 && target.archived === 0) {
			const mergedAtom: MemoryAtom = {
				...target,
				type: itemWithNormTags.type,
				title: itemWithNormTags.title,
				content: itemWithNormTags.content,
				summary: itemWithNormTags.summary,
				tags: normalizedTags,
				importance: itemWithNormTags.importance,
				content_fingerprint: fingerprint,
				updated_at: Date.now(),
			};
			const embeddableText = buildEmbeddableText(mergedAtom);
			const embedding = await embedText(embeddableText);
			const vector = embedding ?? new Array(1024).fill(0);
			await index.updateAtom(mergedAtom, vector);
			await writeAtomToFile(mergedAtom, atomsDir);
			await reindexOneOrWarn(mergedAtom.id);
			return { status: "update", atom: mergedAtom };
		}
		console.warn(
			`[extract] item.oldId=${itemWithNormTags.oldId} not found in active atoms, falling back to create for item "${itemWithNormTags.title}"`,
		);
	}

	// 4. Create path.
	const newAtom = buildAtomFromItem(itemWithNormTags, fingerprint);
	const embeddableText = buildEmbeddableText(newAtom);
	const embedding = await embedText(embeddableText);
	const vector = embedding ?? new Array(1024).fill(0);
	const finalNew = await persistCreate(index, atomsDir, newAtom, vector);
	return { status: "create", atom: finalNew };
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
		strength: 1.0,
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
 *   - created: new atoms written to DB + file (no oldId, fresh insert)
 *   - updated:  pairs of (oldId, newAtom) for atoms the LLM merged into via
 *     oldId (in-place rewrite preserves the id; the new content stays on the
 *     same atom row). oldId here equals newAtom.id.
 *   - skipped:  existing atoms that matched the item fingerprint exactly
 *     (sha256 of normalised content) — the LLM re-emitted a duplicate.
 *
 * Items are processed in order — the spec is sequential, not parallel.
 *
 * The `callLlm` parameter is retained for backward source compatibility with
 * callers (webui/CLI) that historically passed an LLM closure; `executeItem`
 * no longer routes through it (no second-pass dedup confirm in this design).
 */
export async function executePlan(
	index: MemoryIndex,
	atomsDir: string,
	plan: ExtractionPlan,
	callLlm?: (prompt: string) => Promise<string>,
): Promise<{
	created: MemoryAtom[];
	updated: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	const created: MemoryAtom[] = [];
	const updated: Array<{ oldId: string; newAtom: MemoryAtom }> = [];
	const skipped: MemoryAtom[] = [];

	for (const planItem of plan.items) {
		const result = await executeItem(index, atomsDir, planItem.item as ExtractionItem & { oldId?: string }, callLlm);
		if (!result.atom) continue;
		switch (result.status) {
			case "create":
				created.push(result.atom);
				break;
			case "update":
				// For update, the hit atom is rewritten in place — its id is
				// preserved, so `oldId === result.atom.id`.
				updated.push({ oldId: result.atom.id, newAtom: result.atom });
				break;
			case "skip":
				skipped.push(result.atom);
				break;
		}
	}

	return { created, updated, skipped };
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

// ---------------------------------------------------------------------------
// scoreUserTone — 5-tier user tone scoring
// ---------------------------------------------------------------------------
//
// Bilingual word lists scanned against the joined content of ALL user
// messages. The strongest tier hit wins (STRONG > HABIT > WEAK > RARE;
// NEUTRAL when nothing matches). Pure substring matching via `includes` —
// microseconds, no LLM call. The resulting `importanceHint` is an anchor
// for the extraction LLM, which may still deviate ±0.15 from it.

const STRONG_WORDS = ["千万", "务必", "必须", "一定要", "must", "always", "never", "绝对", "禁止"];
const HABIT_WORDS = ["总是", "永远", "记得", "每次", "习惯", "usually", "often", "always do"];
const WEAK_WORDS = ["可能", "也许", "大概", "如果", "maybe", "perhaps", "might", "could"];
const RARE_WORDS = ["偶尔", "有时", "sometimes", "rarely"];

/**
 * Score the user's tone across every user-role message in `messages`.
 * Returns `{ level, importanceHint }` where `importanceHint` is the anchor
 * the extraction LLM should bias toward when picking `importance`.
 *
 * Tier priority: STRONG (0.85) > HABIT (0.65) > WEAK (0.35) > RARE (0.2);
 * NEUTRAL (0.5) when none of the words hit. The function aggregates across
 * all user messages — not just the latest — so a single strongly-worded
 * message in a long conversation still promotes the whole transcript.
 */
export function scoreUserTone(messages: Array<{ role: string; content: string }>): {
	level: "strong" | "habit" | "neutral" | "weak" | "rare";
	importanceHint: number;
} {
	const userText = messages
		.filter((m) => m.role === "user")
		.map((m) => m.content)
		.join("\n");
	if (STRONG_WORDS.some((w) => userText.includes(w))) return { level: "strong", importanceHint: 0.85 };
	if (HABIT_WORDS.some((w) => userText.includes(w))) return { level: "habit", importanceHint: 0.65 };
	if (WEAK_WORDS.some((w) => userText.includes(w))) return { level: "weak", importanceHint: 0.35 };
	if (RARE_WORDS.some((w) => userText.includes(w))) return { level: "rare", importanceHint: 0.2 };
	return { level: "neutral", importanceHint: 0.5 };
}

/**
 * Build the full prompt that gets sent to the LLM: instruction + (optional)
 * user tone hint + the conversation transcript. Kept as a pure function so
 * it can be inspected in tests without needing to mock the LLM.
 *
 * When `scoreUserTone` returns a non-NEUTRAL level, a `<user_tone>` +
 * `<importance_hint>` block is inserted between the system prompt and the
 * messages section. NEUTRAL messages inject nothing — the prompt stays
 * byte-identical to the v1 shape.
 */
export interface BuildExtractionPromptOptions {
	tagVocabulary?: string[];
	/** Top-K recalled atoms with full content preview, surfaced in the
	 *  corpus section so the LLM can decide update-vs-create via oldId. */
	recalledAtoms?: Array<{
		id: string;
		type: string;
		title: string;
		summary: string;
		content: string;
		path: string;
	}>;
}

export const RECALL_TOP_K = 20;
export const CONTENT_PREVIEW_CHARS = 300;

export function buildExtractionPrompt(
	messages: Array<{ role: string; content: string }>,
	opts?: BuildExtractionPromptOptions,
): string {
	const messagesText = messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
	const tone = scoreUserTone(messages);
	const toneHint = tone.level === "neutral"
		? ""
		: `<user_tone>${tone.level}</user_tone>\n<importance_hint>${tone.importanceHint}</importance_hint>\n\n`;
	const tagDict = opts?.tagVocabulary ?? [];
	const tagDictSection = tagDict.length > 0
		? `\n\n## 现有 tag 字典 (优先复用, 不要发明新近义 tag)\n${tagDict.join(", ")}`
		: "";
	const corpusSection = opts?.recalledAtoms && opts.recalledAtoms.length > 0
		? `\n\n## 高相关已有知识库 (recall top-${opts.recalledAtoms.length}, ${CONTENT_PREVIEW_CHARS}-字预览)\n${opts.recalledAtoms.map((a, i) => {
			const preview = a.content.length > CONTENT_PREVIEW_CHARS
				? `${a.content.slice(0, CONTENT_PREVIEW_CHARS).trimEnd()}\n[…(截断,共 ${a.content.length} 字)]`
				: a.content;
			return `### ${i + 1}. [${a.type}] ${a.title}\n- id: ${a.id}\n- summary: ${a.summary}\n- content: ${preview}\n- path: ${a.path}`;
		}).join("\n\n")}\n`
		: "";
	return `${EXTRACT_PROMPT_V2}${tagDictSection}${corpusSection}\n\n${toneHint}## Messages\n\n${messagesText}\n\n## Output (JSON only)`;
}

/**
 * Internal helper shared by the extraction entry point. Given a parsed
 * LLM response (or null on parse failure) and an execution context,
 * returns the plan + the buckets of atoms created/superseded/updated/skipped.
 *
 * Writes the extraction report to the standard log directory as a side
 * effect so the audit trail captures every run, including the empty ones.
 *
 * `callLlm` is forwarded to `executePlan` → `executeItem` so a cosine hit
 * (no LLM 二次确认 in this design — the LLM is the sole decision-maker).
 */
async function executeParsedPlan(
	index: MemoryIndex,
	atomsDir: string,
	parsed: ExtractionResult | null,
	modelUsed: string,
	callLlm?: (prompt: string) => Promise<string>,
): Promise<{
	plan: ExtractionPlan;
	created: MemoryAtom[];
	updated: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	if (!parsed) {
		return {
			plan: { items: [], modelUsed, generatedAt: Date.now() },
			created: [],
			updated: [],
			skipped: [],
		};
	}

	const plan: ExtractionPlan = {
		items: parsed.items.map((item) => ({ item, status: "create" })),
		modelUsed,
		generatedAt: Date.now(),
	};

	const execResult = await executePlan(index, atomsDir, plan, callLlm);
	await writeExtractionReport(plan);
	return { plan, ...execResult };
}

/**
 * Extract memories from a conversation transcript using a caller-supplied
 * `(prompt) => response` callback. Webui passes its HTTP-side LLM call
 * here; the index lifecycle stays in the caller's hands so this function
 * is reusable inside a longer-lived process.
 *
 * The `callLlm` closure is used ONCE (via `buildExtractionPrompt`) to
 * produce the extraction plan — update vs create is fully resolved in
 * that single LLM call via the `oldId` field on each emitted item. There
 * is no second-pass dedup confirm; the same closure is forwarded to
 * `executePlan` only for backward compatibility with webui callers that
 * historically passed one, but `executeItem` no longer invokes it.
 *
 * `config.tagVocabulary` (optional) is forwarded to `buildExtractionPrompt`
 * so the LLM sees the existing tag dictionary before proposing new tags —
 * drives reuse over near-synonym invention. Caller is responsible for
 * sourcing the vocabulary (memory.ts uses a size-keyed in-memory cache
 * over `loadTagVocabulary`).
 */
export async function extractMemoriesWithCallLlm(
	callLlm: (prompt: string) => Promise<string>,
	messages: Array<{ role: string; content: string }>,
	index: MemoryIndex,
	config: { atomsDir: string; model?: string; tagVocabulary?: string[] },
): Promise<{
	plan: ExtractionPlan;
	created: MemoryAtom[];
	updated: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	// Collect recall top-K atoms (id + summary + content preview + path) so
	// the LLM can pick an oldId for update targets in the items it emits.
	const recalledAtoms = await collectRecalledAtoms(index, messages, config.atomsDir);
	const prompt = buildExtractionPrompt(messages, {
		tagVocabulary: config.tagVocabulary,
		recalledAtoms,
	});
	const response = await callLlm(prompt);
	const parsed = parseExtractionJson(response);
	if (!parsed) {
		// Log the raw response so 0-atom extractions are diagnosable. Without
		// this, a model returning non-JSON (e.g. a truncated response, a
		// refusal, or thinking-block-only output) silently produces 0 items
		// with no clue why. Truncate to 2000 chars to avoid flooding the log.
		const preview = response.length > 2000 ? `${response.slice(0, 2000)}…(${response.length} chars total)` : response;
		console.warn(`[extract] parseExtractionJson returned null — raw LLM response (model=${config.model ?? "unknown"}):\n${preview}`);
	}
	return executeParsedPlan(index, config.atomsDir, parsed, config.model ?? "unknown", callLlm);
}

/**
 * Collect recall top-K atoms with full content preview and .md path, so the
 * LLM can target an update via oldId without going through a second-pass
 * cosine gate. The id + path pair is the only authoritative update reference.
 *
 * Returns one row per atom id (recall dedups internally). Empty array on
 * recall failure (non-fatal — the LLM still sees the messages and can emit
 * creates, but loses the corpus dedup cue).
 */
async function collectRecalledAtoms(
	index: MemoryIndex,
	messages: Array<{ role: string; content: string }>,
	atomsDir: string,
): Promise<Array<{ id: string; type: string; title: string; summary: string; content: string; path: string }>> {
	const userText = messages
		.filter((m) => m.role === "user")
		.map((m) => m.content)
		.join(" ")
		.slice(0, 4000);
	if (userText.trim().length === 0) return [];

	let hits;
	try {
		hits = await recallAtoms(index, userText, { topK: RECALL_TOP_K });
	} catch {
		return [];
	}

	const result: Array<{ id: string; type: string; title: string; summary: string; content: string; path: string }> = [];
	for (const hit of hits.slice(0, RECALL_TOP_K)) {
		const a = hit.atom;
		const fullContent = (a.content ?? "").toString();
		result.push({
			id: a.id,
			type: a.type,
			title: a.title,
			summary: a.summary,
			content: fullContent,
			path: `${atomsDir}/${a.type}/${a.id}.md`,
		});
	}
	return result;
}

/** Options for the webui entry point. Bundles everything the caller has to know. */
export interface RunMemoryExtractionOptions {
	callLlm: (prompt: string) => Promise<string>;
	config: { model?: string; tagVocabulary?: string[] };
	messages: Array<{ role: string; content: string }>;
	dbPath: string;
	atomsDir: string;
}

/** Result bundle for the webui entry point. */
export interface RunMemoryExtractionResult {
	plan: ExtractionPlan;
	created: MemoryAtom[];
	updated: Array<{ oldId: string; newAtom: MemoryAtom }>;
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
			tagVocabulary: opts.config.tagVocabulary,
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