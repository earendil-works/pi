import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { recordModelUsage } from "../src/model-usage.js";

describe("model usage snapshot", () => {
	let dir: string | null = null;

	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		}
	});

	it("records usage to a per-workspace snapshot file", () => {
		dir = mkdtempSync(join(tmpdir(), "mu-model-usage-"));

		const now = 1_700_000_000_000;
		recordModelUsage(dir, "openai", "gpt-4o", now);
		recordModelUsage(dir, "openai", "gpt-4o", now + 1234);
		recordModelUsage(dir, "anthropic", "claude", now + 2222);

		const snapshotPath = join(dir, ".model-usage-stats.json");
		const raw = readFileSync(snapshotPath, "utf8");
		const parsed = JSON.parse(raw) as {
			version: number;
			updatedAt: number;
			stats: Record<string, { count: number; lastUsed: number }>;
		};

		expect(parsed.version).toBe(1);
		expect(typeof parsed.updatedAt).toBe("number");

		expect(parsed.stats["openai/gpt-4o"]).toEqual({
			count: 2,
			lastUsed: now + 1234,
		});
		expect(parsed.stats["anthropic/claude"]).toEqual({
			count: 1,
			lastUsed: now + 2222,
		});
	});
});
