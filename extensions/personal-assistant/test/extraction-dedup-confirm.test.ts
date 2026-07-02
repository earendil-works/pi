import { describe, it, expect, vi } from "vitest";
import { confirmDedupAction } from "../extraction-dedup-confirm.ts";
import type { MemoryAtom, ExtractionItem } from "../types.ts";

// Fixture builders — keep tests focused on the function under test, not on
// constructing realistic atoms from scratch. The shape mirrors what
// types.ts guarantees; only the fields that the prompt / schema reference
// are populated.
function makeHitAtom(overrides: Partial<MemoryAtom> = {}): MemoryAtom {
	return {
		id: "hit-atom-1",
		type: "fact",
		title: "PDF extraction library",
		summary: "PDF 提取用 pymupdf",
		content: "PDF 提取用 pymupdf 而不是 pdfplumber, 因为 layout 保留更好",
		tags: ["pdf", "image extraction"],
		importance: 0.6,
		strength: 0.6,
		access_count: 0,
		version: 1,
		is_latest: 1,
		parent_id: null,
		superseded_at: null,
		archived: 0,
		created_at: 1719000000000,
		updated_at: 1719000000000,
		last_access: null,
		content_fingerprint: "fp-hit-1",
		source_session: null,
		...overrides,
	};
}

function makeNewItem(overrides: Partial<ExtractionItem> = {}): ExtractionItem {
	return {
		type: "fact",
		title: "PDF extraction library v2",
		summary: "PDF 提取改用 pymupdf + 新的 layout 模式",
		content: "PDF 提取改用 pymupdf 的新 layout 模式, 默认 dpi=200",
		tags: ["pdf", "pymupdf"],
		importance: 0.65,
		...overrides,
	};
}

// callLlm helper: returns a stub that yields the supplied response verbatim.
// The function under test must pass `prompt` to callLlm exactly once; we
// assert this with vi.fn() in the prompt-shape case.
function makeCallLlm(response: string | (() => string)): (prompt: string) => Promise<string> {
	const fn = vi.fn(async () => (typeof response === "string" ? response : response()));
	return fn as unknown as (prompt: string) => Promise<string>;
}

describe("confirmDedupAction — LLM 输出解析", () => {
	it("(l) valid JSON {action: 'update', merged: {...}} → 解析成功, 返回 action + merged", async () => {
		const llmResponse = JSON.stringify({
			action: "update",
			merged: {
				title: "PDF extraction library (updated)",
				summary: "PDF 提取用 pymupdf 新 layout 模式",
				content: "PDF 提取用 pymupdf 而不是 pdfplumber, 因为 layout 保留更好。\n2026-07 新增 dpi=200 默认值",
				tags: ["pdf", "image extraction", "pymupdf"],
			},
		});
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.82);

		expect(result.action).toBe("update");
		expect(result.merged).toBeDefined();
		expect(result.merged?.title).toContain("PDF extraction library");
		expect(result.merged?.tags).toEqual(["pdf", "image extraction", "pymupdf"]);
		// callLlm was invoked exactly once with a non-empty prompt.
		expect(callLlm).toHaveBeenCalledTimes(1);
		const promptArg = (callLlm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as string;
		expect(promptArg.length).toBeGreaterThan(0);
	});

	it("(l2) valid JSON {action: 'supersede'} (no merged field) → 解析成功, merged undefined", async () => {
		const llmResponse = JSON.stringify({ action: "supersede" });
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.91);

		expect(result.action).toBe("supersede");
		expect(result.merged).toBeUndefined();
	});

	it("(l3) valid JSON {action: 'create'} → action='create', merged undefined", async () => {
		const llmResponse = JSON.stringify({ action: "create" });
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.66);

		expect(result.action).toBe("create");
		expect(result.merged).toBeUndefined();
	});

	it("(l4) valid JSON {action: 'skip'} → action='skip'", async () => {
		const llmResponse = JSON.stringify({ action: "skip" });
		const callLlm = makeCallLlm(llmResponse);

		const result = await confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.99);

		expect(result.action).toBe("skip");
		expect(result.merged).toBeUndefined();
	});

	it("(m) invalid JSON → throw 含 'non-JSON'", async () => {
		const callLlm = makeCallLlm("this is not JSON at all");

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/non-JSON/);
	});

	it("(m2) empty string response → throw 'non-JSON'", async () => {
		const callLlm = makeCallLlm("");

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/non-JSON/);
	});

	it("(n) valid JSON but wrong schema (action not in 4 枚举) → throw 'validation' or 'schema'", async () => {
		const llmResponse = JSON.stringify({ action: "merge" }); // not in [update, supersede, create, skip]
		const callLlm = makeCallLlm(llmResponse);

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/validation|schema/i);
	});

	it("(n2) valid JSON, action='update' 但 merged.title 太长 (>200) → throw validation", async () => {
		const llmResponse = JSON.stringify({
			action: "update",
			merged: {
				title: "x".repeat(201),
				summary: "long enough summary text here",
				content: "long enough content text here for validation",
				tags: ["pdf"],
			},
		});
		const callLlm = makeCallLlm(llmResponse);

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/validation|schema/i);
	});

	it("(n3) valid JSON, action='update' 但 merged.tags 超过 10 个 → throw validation", async () => {
		const llmResponse = JSON.stringify({
			action: "update",
			merged: {
				title: "ok title",
				summary: "long enough summary text here",
				content: "long enough content text here for validation",
				tags: new Array(11).fill("tag"),
			},
		});
		const callLlm = makeCallLlm(llmResponse);

		await expect(
			confirmDedupAction(callLlm, makeHitAtom(), makeNewItem(), 0.8),
		).rejects.toThrow(/validation|schema/i);
	});

	it("prompt injects hitAtom + newItem 字段 + cosine", async () => {
		const llmResponse = JSON.stringify({ action: "skip" });
		const callLlm = makeCallLlm(llmResponse);

		const hitAtom = makeHitAtom({ title: "HIT_TITLE_X", tags: ["hit-tag-1", "hit-tag-2"] });
		const newItem = makeNewItem({ title: "NEW_TITLE_Y", tags: ["new-tag-1"] });

		await confirmDedupAction(callLlm, hitAtom, newItem, 0.777);

		const promptArg = (callLlm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as string;
		expect(promptArg).toContain("HIT_TITLE_X");
		expect(promptArg).toContain("NEW_TITLE_Y");
		expect(promptArg).toContain("hit-tag-1, hit-tag-2");
		expect(promptArg).toContain("new-tag-1");
		expect(promptArg).toContain("0.777");
		// No raw placeholders left behind (would mean .replace() missed one).
		expect(promptArg).not.toContain("{hitAtom.title}");
		expect(promptArg).not.toContain("{newItem.title}");
		expect(promptArg).not.toContain("{cosine}");
	});
});