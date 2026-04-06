import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

type ReplayProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

type PromptCacheReplayProjection = {
	api: ReplayProviderApi;
	turnIndex: number;
	stablePrefixHash: string;
	toolLayerHash: string | null;
	longestCommonPrefixBytes: number;
	payload: unknown;
};

type PromptCacheReplayReport = {
	sessionPath: string;
	messageCount: number;
	projections: PromptCacheReplayProjection[];
	warnings: string[];
};

type PromptCacheReplayModule = {
	buildPromptCacheReplayReport(args: {
		sessionPath: string;
		providers: ReplayProviderApi[];
		messages?: Message[];
	}): Promise<PromptCacheReplayReport>;
	resolveDefaultReplaySessionRoots(): string[];
	findReplaySessionFiles(roots?: string[]): string[];
};

async function loadPromptCacheReplayModule(): Promise<PromptCacheReplayModule> {
	return (await import("../src/prompt-cache-replay.js")) as PromptCacheReplayModule;
}

function loadFixtureMessages(): Message[] {
	const raw = readFileSync(new URL("./fixtures/prompt-cache-replay-session.jsonl", import.meta.url), "utf8");
	return raw
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; message?: Message })
		.filter((entry) => entry.type === "message" && entry.message !== undefined)
		.map((entry) => entry.message as Message);
}

describe("prompt cache replay red harness", () => {
	it("projects adjacent turns from a session-manager JSONL transcript into all target provider payloads", async () => {
		const mod = await loadPromptCacheReplayModule();
		const sessionPath = new URL("./fixtures/prompt-cache-replay-session.jsonl", import.meta.url).pathname;

		const report = await mod.buildPromptCacheReplayReport({
			sessionPath,
			providers: ["openai-completions", "openai-responses", "anthropic-messages"],
			messages: loadFixtureMessages(),
		});

		expect(report.sessionPath).toBe(sessionPath);
		expect(report.messageCount).toBeGreaterThanOrEqual(6);
		expect(report.projections.map((projection) => projection.api)).toEqual([
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
		]);
		expect(report.projections.every((projection) => projection.stablePrefixHash.length > 0)).toBe(true);
		expect(report.projections.every((projection) => projection.turnIndex >= 1)).toBe(true);
		expect(report.projections.every((projection) => projection.longestCommonPrefixBytes >= 0)).toBe(true);
	});

	it("discovers real replay session roots under the user's Mu home and supports both legacy and current layouts", async () => {
		const mod = await loadPromptCacheReplayModule();
		const roots = mod.resolveDefaultReplaySessionRoots();

		expect(roots).toContain(join(homedir(), ".mu", "sessions"));
		expect(roots).toContain(join(homedir(), ".mu", "agent", "sessions"));
		expect(mod.findReplaySessionFiles(roots).length).toBeGreaterThan(0);
	});
});
