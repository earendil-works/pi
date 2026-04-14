import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";

function writeSessionFile(dir: string, name: string, header: SessionHeader, messages: unknown[]): string {
	const path = join(dir, name);
	const lines = `${[JSON.stringify(header), ...messages.map((message) => JSON.stringify(message))].join("\n")}\n`;
	writeFileSync(path, lines, "utf8");
	return path;
}

function createHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
	return {
		type: "session",
		version: 3,
		id: overrides.id ?? "test-session",
		timestamp: overrides.timestamp ?? new Date("2026-04-08T00:00:00.000Z").toISOString(),
		cwd: overrides.cwd ?? "/tmp/project",
		parentSession: overrides.parentSession,
		sessionMode: overrides.sessionMode,
	};
}

describe("SessionInfo.isHeadless", () => {
	it("hides explicit headless sessions and keeps explicit interactive ones visible", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-headless-session-mode-"));

		writeSessionFile(dir, "headless.jsonl", createHeader({ id: "headless", sessionMode: "headless" }), [
			{
				type: "message",
				message: { role: "user", content: "You are investigating a triage ticket. Output EXACTLY one JSON block." },
			},
		]);

		writeSessionFile(dir, "interactive.jsonl", createHeader({ id: "interactive", sessionMode: "interactive" }), [
			{
				type: "message",
				message: { role: "user", content: "You are investigating a triage ticket. Output EXACTLY one JSON block." },
			},
		]);

		const sessions = await SessionManager.list("/tmp/project", dir);
		expect(sessions.find((session) => session.id === "headless")?.isHeadless).toBe(true);
		expect(sessions.find((session) => session.id === "interactive")?.isHeadless).toBe(false);
	});

	it("falls back to generic automation prompt detection for legacy sessions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-headless-legacy-"));
		writeSessionFile(dir, "legacy.jsonl", createHeader({ id: "legacy" }), [
			{
				type: "message",
				message: {
					role: "user",
					content:
						"You are investigating a support incident. Your job is to gather evidence, not speculate. Output EXACTLY one JSON block with your findings.",
				},
			},
		]);

		const sessions = await SessionManager.list("/tmp/project", dir);
		expect(sessions.find((session) => session.id === "legacy")?.isHeadless).toBe(true);
	});
});
