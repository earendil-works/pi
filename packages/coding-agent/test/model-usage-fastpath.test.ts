import { describe, expect, it, vi } from "vitest";

describe("loadModelUsageStats fast path", () => {
	it("uses snapshot file without scanning session jsonl files", async () => {
		vi.resetModules();

		const sessionDir = "/tmp/mu-sessions";
		const snapshotPath = `${sessionDir}/.model-usage-stats.json`;

		vi.doMock("fs", () => ({
			existsSync: (p: string) => p === sessionDir || p === snapshotPath,
			readFileSync: (p: string) => {
				if (p !== snapshotPath) throw new Error(`unexpected readFileSync(${p})`);
				return JSON.stringify({
					version: 1,
					updatedAt: 123,
					stats: {
						"openai/gpt-4o": { count: 2, lastUsed: 1000 },
					},
				});
			},
			readdirSync: () => {
				throw new Error("readdirSync should not be called");
			},
			statSync: () => {
				throw new Error("statSync should not be called");
			},
			writeFileSync: () => {
				throw new Error("writeFileSync should not be called");
			},
			mkdirSync: () => {
				throw new Error("mkdirSync should not be called");
			},
			renameSync: () => {
				throw new Error("renameSync should not be called");
			},
		}));

		const { loadModelUsageStats } = await import("../src/model-usage.js");
		const stats = loadModelUsageStats(sessionDir);
		expect(stats.get("openai/gpt-4o")).toEqual({ count: 2, lastUsed: 1000 });
	});
});
