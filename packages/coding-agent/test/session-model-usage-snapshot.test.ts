import type { AgentState } from "@kennyfrc/mu-agent-core";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceSessionDir } from "../src/model-usage.js";
import { SessionManager } from "../src/session-manager.js";

describe("SessionManager -> model usage snapshot wiring", () => {
	const originalConfigDir = process.env.MU_CODING_AGENT_DIR;
	let root: string | null = null;
	let projectDir: string | null = null;

	afterEach(() => {
		process.env.MU_CODING_AGENT_DIR = originalConfigDir;
		if (root) {
			rmSync(root, { recursive: true, force: true });
			root = null;
			projectDir = null;
		}
	});

	it("records usage on session start and model change", () => {
		root = mkdtempSync(join(tmpdir(), "mu-session-model-usage-"));
		process.env.MU_CODING_AGENT_DIR = root;

		projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });

		const sessionManager = new SessionManager(false, undefined, false, projectDir);

		const before = Date.now();
		sessionManager.startSession({
			model: { provider: "openai", id: "gpt-4o" },
			thinkingLevel: "off",
		} as unknown as AgentState);
		const after = Date.now();

		const sessionDir = getWorkspaceSessionDir(projectDir);
		const snapshotPath = join(sessionDir, ".model-usage-stats.json");
		const snapshotRaw = readFileSync(snapshotPath, "utf8");
		const snapshot = JSON.parse(snapshotRaw) as {
			version: number;
			stats: Record<string, { count: number; lastUsed: number }>;
		};

		expect(snapshot.version).toBe(1);
		expect(snapshot.stats["openai/gpt-4o"].count).toBe(1);
		expect(snapshot.stats["openai/gpt-4o"].lastUsed).toBeGreaterThanOrEqual(before);
		expect(snapshot.stats["openai/gpt-4o"].lastUsed).toBeLessThanOrEqual(after);

		const beforeChange = Date.now();
		sessionManager.saveModelChange("openai", "gpt-5");
		const afterChange = Date.now();

		const snapshot2 = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
			version: number;
			stats: Record<string, { count: number; lastUsed: number }>;
		};

		expect(snapshot2.stats["openai/gpt-5"]).toEqual({
			count: 1,
			lastUsed: expect.any(Number),
		});
		expect(snapshot2.stats["openai/gpt-5"].lastUsed).toBeGreaterThanOrEqual(beforeChange);
		expect(snapshot2.stats["openai/gpt-5"].lastUsed).toBeLessThanOrEqual(afterChange);
	});
});
