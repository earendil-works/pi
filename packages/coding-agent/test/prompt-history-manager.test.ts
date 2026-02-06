import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptHistoryManager } from "../src/prompt-history-manager.js";

describe("PromptHistoryManager (slash command persistence)", () => {
	let testDir: string;
	let previousDir: string | undefined;

	beforeEach(() => {
		previousDir = process.env.MU_CODING_AGENT_DIR;
		testDir = join(tmpdir(), `mu-prompt-history-${Date.now()}`);
		process.env.MU_CODING_AGENT_DIR = testDir;
	});

	afterEach(() => {
		if (previousDir === undefined) {
			delete process.env.MU_CODING_AGENT_DIR;
		} else {
			process.env.MU_CODING_AGENT_DIR = previousDir;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it("stores /handoff so Up-arrow can recall it", () => {
		const manager = new PromptHistoryManager();
		manager.savePrompt("/handoff Fix the thing\n\nMore details");

		const history = manager.getHistory();
		expect(history[history.length - 1]).toBe("/handoff Fix the thing\n\nMore details");
	});

	it("still ignores other slash commands", () => {
		const manager = new PromptHistoryManager();
		manager.savePrompt("/model");
		manager.savePrompt("/thinking");
		expect(manager.getHistory()).toEqual([]);
	});
});
