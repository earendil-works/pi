import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { buildMemorySection, summarizeConversation } from "../src/memory/inject.ts";
import { MemoryStore, SUMMARY_TAG } from "../src/memory/store.ts";
import { createMemoryRememberTool, createMemorySearchTool } from "../src/memory/tools.ts";
import { createStreamFn } from "../src/stream-fn.ts";

function createTempStore(): { store: MemoryStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "rp-mem-"));
	return { store: new MemoryStore(join(dir, "memory.json")), dir };
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

describe("MemoryStore", () => {
	it("adds, searches, and removes entries", () => {
		const { store, dir } = createTempStore();
		try {
			store.add("阿琳喜欢麦酒", ["tavern", "drink"]);
			store.add("客人说他要前往北方雪原", ["plot"]);
			expect(store.search("麦酒", 5)).toHaveLength(1);
			expect(store.search("雪原", 5)).toHaveLength(1);
			expect(store.search("不存在的词", 5)).toHaveLength(0);
			expect(store.search("麦酒 雪原", 5)).toHaveLength(2);
			expect(store.remove(store.list()[0].id)).toBe(true);
			expect(store.list()).toHaveLength(1);
		} finally {
			cleanup(dir);
		}
	});

	it("persists entries to disk and reloads them", () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-mem-"));
		try {
			const file = join(dir, "memory.json");
			const store = new MemoryStore(file);
			store.add("持久化的记忆", ["persist"]);
			const reloaded = new MemoryStore(file);
			expect(reloaded.search("持久化的记忆", 5)).toHaveLength(1);
			expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
		} finally {
			cleanup(dir);
		}
	});

	it("tolerates a missing or corrupt file", () => {
		const dir = mkdtempSync(join(tmpdir(), "rp-mem-"));
		try {
			const file = join(dir, "memory.json");
			const store = new MemoryStore(file);
			expect(store.list()).toEqual([]);
			const corrupt = new MemoryStore(file);
			corrupt.save();
			const bad = new MemoryStore(join(dir, "broken.json"));
			bad.add("x", []);
		} finally {
			cleanup(dir);
		}
	});

	it("supports summary upsert and tag exclusion", () => {
		const { store, dir } = createTempStore();
		try {
			store.upsertByTag(SUMMARY_TAG, "第一版摘要");
			expect(store.findByTag(SUMMARY_TAG)?.text).toBe("第一版摘要");
			store.upsertByTag(SUMMARY_TAG, "第二版摘要");
			expect(store.findByTag(SUMMARY_TAG)?.text).toBe("第二版摘要");
			expect(store.list()).toHaveLength(1);
			store.add("需要排除的普通记忆", []);
			expect(store.search("摘要", 5, [SUMMARY_TAG])).toHaveLength(0);
		} finally {
			cleanup(dir);
		}
	});
});

describe("memory tools", () => {
	it("memory_search returns matching entries and omits the summary", async () => {
		const { store, dir } = createTempStore();
		try {
			store.add("阿琳的猫叫煤球", ["pet"]);
			store.upsertByTag(SUMMARY_TAG, "对话摘要内容");
			const tool = createMemorySearchTool(store);
			const result = await tool.execute("1", { query: "猫" });
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			expect(text).toContain("煤球");
			expect(text).not.toContain("对话摘要");
		} finally {
			cleanup(dir);
		}
	});

	it("memory_remember stores a fact", async () => {
		const { store, dir } = createTempStore();
		try {
			const tool = createMemoryRememberTool(store);
			const result = await tool.execute("2", { text: "客人怕冷", tags: ["user"] });
			expect(result.content).toEqual([{ type: "text", text: "Remembered." }]);
			expect(store.search("怕冷", 5)).toHaveLength(1);
		} finally {
			cleanup(dir);
		}
	});

	it("memory_search reports no matches", async () => {
		const { store, dir } = createTempStore();
		try {
			const tool = createMemorySearchTool(store);
			const result = await tool.execute("3", { query: "不存在的话题" });
			expect(result.content).toEqual([{ type: "text", text: "No memories found for that query." }]);
		} finally {
			cleanup(dir);
		}
	});
});

describe("memory injection", () => {
	it("builds a memory section from summary and relevant memories", () => {
		const { store, dir } = createTempStore();
		try {
			store.upsertByTag(SUMMARY_TAG, "阿琳和客人聊到了天气");
			store.add("客人想去北方", ["plot"]);
			const section = buildMemorySection(store, "北方有什么", 5);
			expect(section).toContain("## Conversation so far");
			expect(section).toContain("天气");
			expect(section).toContain("## Relevant memories");
			expect(section).toContain("北方");
		} finally {
			cleanup(dir);
		}
	});

	it("returns an empty section when there are no memories", () => {
		const { store, dir } = createTempStore();
		try {
			expect(buildMemorySection(store, "任意查询", 5)).toBe("");
		} finally {
			cleanup(dir);
		}
	});

	it("summarizes a conversation with the faux provider", async () => {
		const faux: FauxProviderRegistration = registerFauxProvider();
		try {
			faux.setResponses([fauxAssistantMessage("摘要：阿琳和客人聊了天气。")]);
			const model = faux.getModel();
			const summary = await summarizeConversation(model, createStreamFn(), [
				{ role: "user", content: [{ type: "text", text: "今天天气不错" }], timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "是啊，适合赶路" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			]);
			expect(summary).toBe("摘要：阿琳和客人聊了天气。");
		} finally {
			faux.unregister();
		}
	});
});
