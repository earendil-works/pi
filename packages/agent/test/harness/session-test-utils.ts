import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@lyla/agent";
import { afterEach } from "vitest";

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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
	};
}

const tempDirs: string[] = [];

export function createTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

export function getLatestTempDir(): string {
	return tempDirs[tempDirs.length - 1]!;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
