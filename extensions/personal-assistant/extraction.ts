import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { embedText, buildEmbeddableText } from "./embed.ts";
import { writeAtomToFile } from "./file-store.ts";
import { supersedeIfSimilar } from "./dedup.ts";
import { MemoryIndex } from "./storage.ts";
import { normalizeTag, conceptTagCount } from "./tag-vocab.ts";
import { confirmDedupAction } from "./extraction-dedup-confirm.ts";
import { reindexOne } from "./bge-reindex.ts";
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

## User Tone Hint

如果用户消息携带 \`<user_tone>\` 和 \`<importance_hint>\` 段,这表示用户语气的强度暗示。LLM 应基于此**调整 importance**,但仍可上下浮动 ±0.15 — 这是 hint,不是 hardcode。

## Dedup 策略 (重要!)

代码会自动处理 dedup, 你不需要担心:
- 内容指纹 (sha256) → 完全重复跳过
- 余弦相似度 ≥ 0.65 → 旧 atom 自动 superseded

所以你只管 emit, 不需要 emit "skip" 或 "merge" 类标记。

## 主动更新,非扩张 (重要!)

- 如果新信息可归入 corpus 已有的 atom (主题/对象/项目相同), 优先更新该 atom 的 content, 不要为这条信息创建新 atom
- 更新方式: 在 content 末尾追加新段落, 标注日期 (e.g. "2026-07 新增 JSON 格式支持")
- 仅在信息属于全新主题/新对象/新项目时才创建新 atom
- 这是 corpus 持续精炼的关键: 主动合并而非堆叠

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
// Test-only access to executeItem
// ---------------------------------------------------------------------------
//
// `executeItem` is module-private so the public surface stays narrow. Tests
// that need direct access (extraction-dedup-confirm.test.ts scenarios a-i)
// import this alias instead of reaching into a private symbol via a cast.
// The leading underscore + comment make the "internal-only, do not import
// from app code" intent loud. tsgo enforces the visibility boundary; the
// name itself is a soft convention.

/** @internal — test-only access to executeItem (otherwise private). */
export const __testing_executeItem = executeItem;

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
 * Execute a single extraction item against the index:
 *   1. fingerprint dedup: skip when an active atom with the same fingerprint
 *      exists (cheapest check, runs first).
 *   2. tag normalization: trim/lowercase/dictionary-match via
 *      `normalizeTag`, then warn if no `concept/*` tag is present (R10).
 *   3. cosine dedup gate: when embedding + a ≥ 0.65 hit is found:
 *      - with `callLlm`: ask the LLM to disambiguate update/supersede/
 *        create/skip via `confirmDedupAction`. Failures (timeout,
 *        non-JSON, schema mismatch) collapse to the conservative
 *        "supersede" fallback so the corpus never silently absorbs an
 *        unconfirmed duplicate.
 *      - without `callLlm`: legacy supersede path via `supersedeIfSimilar`.
 *   4. create: insertAtom + writeAtomToFile + bge-m3 reindex.
 *   5. every write path (update / supersede / create) ends with
 *      `reindexOneOrWarn` so the dense channel stays in sync.
 *
 * Returns the outcome (skip / supersede / update / create) and the resulting
 * atom when applicable. Embedding failures collapse to "create with
 * zero-vector" so the file write still happens — sqlite-vec accepts zero
 * vectors and downstream recall simply misses this atom until a real
 * embedding lands.
 */
async function executeItem(
	index: MemoryIndex,
	atomsDir: string,
	item: ExtractionItem,
	callLlm?: (prompt: string) => Promise<string>,
): Promise<{ status: "skip" | "supersede" | "update" | "create"; atom?: MemoryAtom }> {
	const fingerprint = computeFingerprint(item.content);

	// 1. Fingerprint dedup — cheapest check first.
	const existing = index.getActiveAtomByFingerprint(fingerprint);
	if (existing) {
		return { status: "skip", atom: existing };
	}

	// 2. Tag normalization + concept-tag presence check. normalizeTag is
	// pure (no I/O) so the warn is safe to log here; we don't gate on the
	// concept count, just log when the LLM failed to emit a `concept/*` tag.
	const normalizedTags = item.tags.map((t) => normalizeTag(t));
	const conceptCount = conceptTagCount(normalizedTags);
	if (conceptCount === 0) {
		console.warn(
			`[extract] item "${item.title}" lacks concept tag (0/${normalizedTags.length} tags are concept/*)`,
		);
	}
	const itemWithNormTags: ExtractionItem = { ...item, tags: normalizedTags };

	const newAtom = buildAtomFromItem(itemWithNormTags, fingerprint);
	const embeddableText = buildEmbeddableText(newAtom);
	const embedding = await embedText(embeddableText);
	const vector = embedding ?? new Array(1024).fill(0);

	// 3. Cosine dedup gate. Self-match (similar.atom.id === newAtom.id) is
	// a "no hit" case for the LLM-confirmation path — there is no other
	// atom to disambiguate against, so we drop down to the create branch.
	const similar = embedding ? index.findMostSimilarEmbedding(embedding, 0.65) : null;

	if (similar && similar.atom.id !== newAtom.id) {
		if (callLlm) {
			// LLM 二次确认 path (target 2 core). Any failure here is a
			// conservative fallback to "supersede" so a transient LLM
			// outage doesn't silently absorb unconfirmed duplicates.
			try {
				const decision = await confirmDedupAction(
					callLlm,
					similar.atom,
					itemWithNormTags,
					similar.cosine,
				);
				switch (decision.action) {
					case "update": {
						if (!decision.merged) {
							// LLM said "update" but gave us no merged body —
							// treat as a soft error and fall back to
							// supersede. Without a merged body, an in-place
							// update would be a no-op anyway.
							console.warn(
								`[extract] LLM dedup confirm returned "update" without merged, fell back to supersede for item "${item.title}" (hit ${similar.atom.id})`,
							);
							const { newAtom: finalNew } = index.markSupersededTx(
								similar.atom.id,
								newAtom,
								vector,
							);
							await writeAtomToFile(finalNew, atomsDir);
							await reindexOneOrWarn(finalNew.id);
							return { status: "supersede", atom: finalNew };
						}
						// In-place update of the hit atom: rewrite the four
						// mutable content fields, recompute the fingerprint
						// from the new content (the active-fingerprint
						// UNIQUE partial index depends on this), and
						// pass through to updateAtom (which bumps version
						// + writes the new vector in one transaction).
						const mergedAtom: MemoryAtom = {
							...similar.atom,
							title: decision.merged.title,
							summary: decision.merged.summary,
							content: decision.merged.content,
							tags: decision.merged.tags,
							content_fingerprint: computeFingerprint(decision.merged.content),
						};
						await index.updateAtom(mergedAtom, vector);
						await writeAtomToFile(mergedAtom, atomsDir);
						await reindexOneOrWarn(mergedAtom.id);
						return { status: "update", atom: mergedAtom };
					}
					case "supersede": {
						const { newAtom: finalNew } = index.markSupersededTx(
							similar.atom.id,
							newAtom,
							vector,
						);
						await writeAtomToFile(finalNew, atomsDir);
						await reindexOneOrWarn(finalNew.id);
						return { status: "supersede", atom: finalNew };
					}
					case "create": {
						// Cosine hit was a coincidence — keep both atoms.
						await index.insertAtom(newAtom, vector);
						await writeAtomToFile(newAtom, atomsDir);
						await reindexOneOrWarn(newAtom.id);
						return { status: "create", atom: newAtom };
					}
					case "skip": {
						console.log(
							`[extract] dedup-confirm: skip item "${item.title}" (hit ${similar.atom.id})`,
						);
						return { status: "skip", atom: similar.atom };
					}
				}
			} catch (err) {
				// LLM call failed (non-JSON, schema mismatch, timeout
				// propagated from callLlm). Conservative fallback:
				// supersede. A failed confirm must not silently merge
				// the new info into the hit atom.
				console.warn(
					`[extract] LLM dedup confirm failed for item "${item.title}" (hit ${similar.atom.id}), fell back to supersede: ${err instanceof Error ? err.message : String(err)}`,
				);
				const { newAtom: finalNew } = index.markSupersededTx(
					similar.atom.id,
					newAtom,
					vector,
				);
				await writeAtomToFile(finalNew, atomsDir);
				await reindexOneOrWarn(finalNew.id);
				return { status: "supersede", atom: finalNew };
			}
		} else {
			// No callLlm — legacy supersede path. Preserves the v1
			// behaviour exactly so callers that haven't adopted the
			// LLM-confirmation pass (e.g. tests) still get a deterministic
			// supersede on a cosine hit.
			const dedupResult = await supersedeIfSimilar(index, atomsDir, newAtom, embedding);
			if (dedupResult.status === "supersede") {
				await reindexOneOrWarn(dedupResult.atom.id);
				return { status: "supersede", atom: dedupResult.atom };
			}
			// supersedeIfSimilar returned "create" — no hit (e.g. self-match).
			await index.insertAtom(newAtom, vector);
			await writeAtomToFile(newAtom, atomsDir);
			await reindexOneOrWarn(newAtom.id);
			return { status: "create", atom: newAtom };
		}
	}

	// 4. No cosine hit — direct create.
	await index.insertAtom(newAtom, vector);
	await writeAtomToFile(newAtom, atomsDir);
	await reindexOneOrWarn(newAtom.id);
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
 * Process every item in the plan sequentially and return four buckets:
 *   - created: new atoms written to DB + file (no cosine hit, or LLM said "create")
 *   - superseded: pairs of (oldId, newAtom) for atoms replaced by similar content
 *   - updated: pairs of (oldId, newAtom) for atoms the LLM chose to merge into
 *     (update action from confirmDedupAction — the `oldId` is a stable key
 *     for callers; the returned `newAtom` IS the hit atom post-rewrite)
 *   - skipped: existing atoms that matched the fingerprint exactly OR that
 *     the LLM chose to skip after a cosine-confirm pass
 *
 * Items are processed in order — the spec is sequential, not parallel.
 *
 * `callLlm` is forwarded to every `executeItem` call so a cosine hit can be
 * disambiguated by the LLM before the write. Optional — omitting it falls
 * back to the legacy "auto-supersede on cosine hit" path.
 */
export async function executePlan(
	index: MemoryIndex,
	atomsDir: string,
	plan: ExtractionPlan,
	callLlm?: (prompt: string) => Promise<string>,
): Promise<{
	created: MemoryAtom[];
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	updated: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	const created: MemoryAtom[] = [];
	const superseded: Array<{ oldId: string; newAtom: MemoryAtom }> = [];
	const updated: Array<{ oldId: string; newAtom: MemoryAtom }> = [];
	const skipped: MemoryAtom[] = [];

	for (const planItem of plan.items) {
		const result = await executeItem(index, atomsDir, planItem.item, callLlm);
		if (result.status === "create" && result.atom) {
			created.push(result.atom);
		} else if (result.status === "supersede" && result.atom) {
			// For supersede, `result.atom.parent_id` is set by
			// `markSupersededTx` to the hit atom's id (the one being
			// replaced) — that's the stable key audit/recall consumers
			// expect here, NOT the new item's title.
			superseded.push({ oldId: result.atom.parent_id ?? "", newAtom: result.atom });
		} else if (result.status === "update" && result.atom) {
			// For update, the hit atom is rewritten in place — its id is
			// preserved, so `oldId === result.atom.id`.
			updated.push({ oldId: result.atom.id, newAtom: result.atom });
		} else if (result.status === "skip" && result.atom) {
			skipped.push(result.atom);
		}
	}

	return { created, superseded, updated, skipped };
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
}

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
	return `${EXTRACT_PROMPT_V2}${tagDictSection}\n\n${toneHint}## Messages\n\n${messagesText}\n\n## Output (JSON only)`;
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
 * can be disambiguated by the LLM before the write (Task 3.7 target 2).
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
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	updated: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	if (!parsed) {
		return {
			plan: { items: [], modelUsed, generatedAt: Date.now() },
			created: [],
			superseded: [],
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
 * The same `callLlm` closure is used TWICE: first to produce the
 * extraction plan (via `buildExtractionPrompt`), then — if a cosine
 * ≥ 0.65 hit is found during execution — to disambiguate the
 * update/supersede/create/skip action (via `confirmDedupAction`,
 * Task 3.7 target 2). Re-using the same closure means the caller
 * only wires up the LLM once and gets the dedup confirmation pass
 * for free. The 5s timeout the caller applies to `callLlm` covers
 * both passes.
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
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
	updated: Array<{ oldId: string; newAtom: MemoryAtom }>;
	skipped: MemoryAtom[];
}> {
	const prompt = buildExtractionPrompt(messages, { tagVocabulary: config.tagVocabulary });
	const response = await callLlm(prompt);
	const parsed = parseExtractionJson(response);
	return executeParsedPlan(index, config.atomsDir, parsed, config.model ?? "unknown", callLlm);
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
	superseded: Array<{ oldId: string; newAtom: MemoryAtom }>;
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