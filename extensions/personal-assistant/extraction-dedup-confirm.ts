import { z } from "zod";
import type { MemoryAtom, ExtractionItem } from "./types.ts";

// ---------------------------------------------------------------------------
// confirmDedupAction — second-pass LLM dedup confirmation
// ---------------------------------------------------------------------------
//
// When the cosine gate in extraction.ts:executeItem fires (≥ 0.65), the caller
// needs to disambiguate four cases that the embedding similarity alone cannot
// tell apart:
//
//   - update     the new info belongs to the same atom (append + tag-date)
//   - supersede  the new info is a near-twin of an existing atom (mark archive
//                and create a fresh version chain)
//   - create     the cosine hit was a coincidence (different topic) — emit
//                a new atom alongside the existing one and ignore the hit
//   - skip       exact duplicate; drop the new item
//
// The function injects the hit atom and the new item into DEDUP_CONFIRM_PROMPT
// and lets the LLM pick an action. Failures (LLM timeout, non-JSON, schema
// mismatch) are thrown — the caller (executeItem) catches and applies the
// conservative fallback ("supersede") so the corpus never silently absorbs an
// unconfirmed duplicate.
//
// The 5s timeout lives inside the caller's callLlm implementation (memory.ts
// has had it since the v1 extraction work) — this function does not stack its
// own AbortController on top.

// ---------------------------------------------------------------------------
// Schema for the LLM response
// ---------------------------------------------------------------------------

/**
 * Zod schema for the LLM's dedup decision. `merged` is required only when the
 * action is "update" (the LLM has to provide the rewritten atom content) —
 * for supersede / create / skip we accept the action alone. We do NOT enforce
 * the "merged required iff update" rule here because the LLM may legitimately
 * emit an empty merged for an update where the rewrite is a pure tag tweak —
 * the caller can treat a missing merged as "use hitAtom verbatim" downstream.
 */
export const dedupConfirmSchema = z.object({
	action: z.enum(["update", "supersede", "create", "skip"]),
	merged: z
		.object({
			title: z.string().min(1).max(200),
			summary: z.string().min(5).max(500),
			content: z.string().min(10).max(5000),
			tags: z.array(z.string().min(1).max(50)).max(10),
		})
		.optional(),
});

/** Inferred result type — the value returned to the caller. */
export type DedupConfirmResult = z.infer<typeof dedupConfirmSchema>;

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

// DEDUP_CONFIRM_PROMPT: internal-only (not exported). Placeholders are the
// curly-brace form so the .replace() chain below stays readable — they are
// unambiguous because the surrounding markdown never contains literal
// "{cosine}", "{hitAtom.title}", etc.
const DEDUP_CONFIRM_PROMPT = `你是 memory dedup agent。判断"新信息"和"已有 atom"的关系, 决定如何处理。

## 已有 atom (cosine {cosine} 命中)
标题: {hitAtom.title}
摘要: {hitAtom.summary}
内容: {hitAtom.content}
Tags: {hitAtom.tags}

## 新信息
标题: {newItem.title}
摘要: {newItem.summary}
内容: {newItem.content}
Tags: {newItem.tags}

## 决策选项
- update: 新信息可归入已有 atom (同主题/同对象), 在末尾追加 + 标日期
- supersede: 新信息与已有 atom 几乎完全相同, 标 archive + 创建新 atom
- create: 新信息主题与已有 atom 不同, 应该独立 (忽略 hit, 正常创建)
- skip: 完全重复, 啥也不做

## 输出 (JSON only)
{"action": "update|supersede|create|skip", "merged"?: {"title": "...", "summary": "...", "content": "...", "tags": [...]}}
`;

/**
 * Ask the LLM to disambiguate four dedup outcomes for a cosine hit.
 *
 * @param callLlm  Caller-supplied LLM closure. Must already implement a
 *                 timeout (see memory.ts:402-441) — this function does NOT
 *                 add its own AbortController. Throws on timeout / network
 *                 failure, propagating to the caller.
 * @param hitAtom  The existing atom whose cosine similarity cleared the gate.
 *                 Injected verbatim into the prompt.
 * @param newItem  The extraction item being persisted.
 * @param cosine   Cosine similarity in [0,1] — formatted to 3 decimals in
 *                 the prompt so the LLM has a numeric anchor alongside the
 *                 lexical context.
 * @returns        Parsed decision — `{ action, merged? }`.
 * @throws         On non-JSON LLM response (`Error` containing "non-JSON"),
 *                 or on schema validation failure (`Error` containing
 *                 "validation"). Caller is expected to catch and apply the
 *                 conservative "supersede" fallback.
 */
export async function confirmDedupAction(
	callLlm: (prompt: string) => Promise<string>,
	hitAtom: MemoryAtom,
	newItem: ExtractionItem,
	cosine: number,
): Promise<DedupConfirmResult> {
	const prompt = DEDUP_CONFIRM_PROMPT.replace("{cosine}", cosine.toFixed(3))
		.replace("{hitAtom.title}", hitAtom.title)
		.replace("{hitAtom.summary}", hitAtom.summary)
		.replace("{hitAtom.content}", hitAtom.content)
		.replace("{hitAtom.tags}", hitAtom.tags.join(", "))
		.replace("{newItem.title}", newItem.title)
		.replace("{newItem.summary}", newItem.summary)
		.replace("{newItem.content}", newItem.content)
		.replace("{newItem.tags}", newItem.tags.join(", "));

	const response = await callLlm(prompt);

	let parsed: unknown;
	try {
		parsed = JSON.parse(response);
	} catch {
		throw new Error(`LLM dedup confirm: non-JSON response`);
	}

	const result = dedupConfirmSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`LLM dedup confirm: schema validation failed: ${result.error.message}`);
	}
	return result.data;
}