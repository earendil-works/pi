import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listThreadsTool } from "../src/tools/list-threads.js";

function toSafeWorkspaceDirName(workspacePath: string): string {
	return "--" + workspacePath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

function buildSessionFileLines(input: {
	sessionId: string;
	cwd: string;
	firstUserText: string;
	title?: string;
	preview?: string;
}): string {
	const header = {
		type: "session",
		id: input.sessionId,
		timestamp: new Date(0).toISOString(),
		cwd: input.cwd,
		provider: "test",
		modelId: "test",
		thinkingLevel: "off",
	};

	const userMessage = {
		type: "message",
		timestamp: new Date(0).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text: input.firstUserText }],
			timestamp: 0,
		},
	};

	const assistantMessage = {
		type: "message",
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: 0,
		},
	};

	const lines = [JSON.stringify(header), JSON.stringify(userMessage), JSON.stringify(assistantMessage)];

	if (input.title) {
		lines.push(JSON.stringify({ type: "title_change", timestamp: new Date(0).toISOString(), title: input.title }));
	}

	if (input.preview) {
		lines.push(
			JSON.stringify({ type: "preview_change", timestamp: new Date(0).toISOString(), preview: input.preview }),
		);
	}

	return lines.join("\n") + "\n";
}

async function writeSession(input: {
	configDir: string;
	workspaceDir: string;
	sessionId: string;
	firstUserText: string;
	title?: string;
	preview?: string;
	fileName?: string;
}): Promise<void> {
	const sessionsRoot = join(input.configDir, "sessions");
	const sessionDir = join(sessionsRoot, toSafeWorkspaceDirName(input.workspaceDir));
	await mkdir(sessionDir, { recursive: true });

	const sessionFile = join(sessionDir, input.fileName ?? `2026-01-01T00-00-00-000Z_${input.sessionId}.jsonl`);
	await writeFile(
		sessionFile,
		buildSessionFileLines({
			sessionId: input.sessionId,
			cwd: input.workspaceDir,
			firstUserText: input.firstUserText,
			title: input.title,
			preview: input.preview,
		}),
		"utf8",
	);
}

async function listThreads(args: { workspace?: string; search?: string; limit?: number }) {
	const res = await listThreadsTool.execute("toolcall", args);
	const firstBlock = res.content[0];
	if (!firstBlock || firstBlock.type !== "text") throw new Error("Expected text tool result");
	return JSON.parse(firstBlock.text) as Array<Record<string, unknown>>;
}

describe("list_threads: title + preview", () => {
	it("returns persisted title and preview when present", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "mu-list-threads-config-"));
		process.env.MU_CODING_AGENT_DIR = configDir;

		const workspaceDir = await mkdtemp(join(tmpdir(), "mu-list-threads-workspace-"));
		const sessionsRoot = join(configDir, "sessions");
		const sessionDir = join(sessionsRoot, toSafeWorkspaceDirName(workspaceDir));
		await mkdir(sessionDir, { recursive: true });

		const sessionId = "11111111-1111-1111-1111-111111111111";
		const sessionFile = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
		await writeFile(
			sessionFile,
			buildSessionFileLines({
				sessionId,
				cwd: workspaceDir,
				firstUserText: "Hello world",
				title: "My Title",
				preview: "My Preview",
			}),
			"utf8",
		);

		const res = await listThreadsTool.execute("toolcall", { workspace: workspaceDir, limit: 10 });
		const firstBlock = res.content[0];
		if (!firstBlock || firstBlock.type !== "text") throw new Error("Expected text tool result");
		const payload = JSON.parse(firstBlock.text) as Array<Record<string, unknown>>;

		const entry = payload.find((e) => e.id === sessionId);
		expect(entry).toBeTruthy();
		expect(entry?.title).toBe("My Title");
		expect(entry?.preview).toBe("My Preview");
	});

	it("falls back to first message preview with timestamp stripped", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "mu-list-threads-config-"));
		process.env.MU_CODING_AGENT_DIR = configDir;

		const workspaceDir = await mkdtemp(join(tmpdir(), "mu-list-threads-workspace-"));
		const sessionsRoot = join(configDir, "sessions");
		const sessionDir = join(sessionsRoot, toSafeWorkspaceDirName(workspaceDir));
		await mkdir(sessionDir, { recursive: true });

		const sessionId = "22222222-2222-2222-2222-222222222222";
		const sessionFile = join(sessionDir, `2026-01-01T00-00-01-000Z_${sessionId}.jsonl`);
		await writeFile(
			sessionFile,
			buildSessionFileLines({
				sessionId,
				cwd: workspaceDir,
				firstUserText:
					"<user_message_time>Monday, February 16, 2026 at 10:00 AM GMT+8</user_message_time>\n\nHow do I do X?",
				title: "Has Title",
			}),
			"utf8",
		);

		const res = await listThreadsTool.execute("toolcall", { workspace: workspaceDir, limit: 10 });
		const firstBlock = res.content[0];
		if (!firstBlock || firstBlock.type !== "text") throw new Error("Expected text tool result");
		const payload = JSON.parse(firstBlock.text) as Array<Record<string, unknown>>;
		const entry = payload.find((e) => e.id === sessionId);
		expect(entry).toBeTruthy();
		expect(entry?.title).toBe("Has Title");
		expect(entry?.preview).toBe("How do I do X?");
	});

	it("handles large sessions where title/preview are far from the file tail", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "mu-list-threads-config-"));
		process.env.MU_CODING_AGENT_DIR = configDir;

		const workspaceDir = await mkdtemp(join(tmpdir(), "mu-list-threads-workspace-"));
		const sessionsRoot = join(configDir, "sessions");
		const sessionDir = join(sessionsRoot, toSafeWorkspaceDirName(workspaceDir));
		await mkdir(sessionDir, { recursive: true });

		const sessionId = "33333333-3333-3333-3333-333333333333";
		const sessionFile = join(sessionDir, `2026-01-01T00-00-02-000Z_${sessionId}.jsonl`);

		const hugeTail = "x".repeat(200_000);
		const lines = buildSessionFileLines({
			sessionId,
			cwd: workspaceDir,
			firstUserText: "Hello world",
			title: "Large Session Title",
			preview: "Large Session Preview",
		});

		const finalMessage = JSON.stringify({
			type: "message",
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: hugeTail }],
				timestamp: 0,
			},
		});

		await writeFile(sessionFile, lines + finalMessage + "\n", "utf8");

		const res = await listThreadsTool.execute("toolcall", { workspace: workspaceDir, limit: 10 });
		const firstBlock = res.content[0];
		if (!firstBlock || firstBlock.type !== "text") throw new Error("Expected text tool result");
		const payload = JSON.parse(firstBlock.text) as Array<Record<string, unknown>>;
		const entry = payload.find((e) => e.id === sessionId);
		expect(entry).toBeTruthy();
		expect(entry?.title).toBe("Large Session Title");
		expect(entry?.preview).toBe("Large Session Preview");
	});

	it("lists threads across all workspaces when workspace is global or all", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "mu-list-threads-config-"));
		process.env.MU_CODING_AGENT_DIR = configDir;

		const workspaceA = await mkdtemp(join(tmpdir(), "mu-list-threads-workspace-a-"));
		const workspaceB = await mkdtemp(join(tmpdir(), "mu-list-threads-workspace-b-"));

		await writeSession({
			configDir,
			workspaceDir: workspaceA,
			sessionId: "global-a",
			firstUserText: "auth question",
			fileName: "2026-01-01T00-00-00-000Z_global-a.jsonl",
		});
		await writeSession({
			configDir,
			workspaceDir: workspaceB,
			sessionId: "global-b",
			firstUserText: "billing question",
			fileName: "2026-01-01T00-00-01-000Z_global-b.jsonl",
		});

		const globalPayload = await listThreads({ workspace: "global", limit: 10 });
		const allPayload = await listThreads({ workspace: "all", limit: 10 });

		expect(globalPayload.map((entry) => entry.id)).toEqual(["global-b", "global-a"]);
		expect(allPayload.map((entry) => entry.id)).toEqual(["global-b", "global-a"]);
	});

	it("searches across all workspaces in global mode and preserves default current-workspace behavior", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "mu-list-threads-config-"));
		process.env.MU_CODING_AGENT_DIR = configDir;

		const currentWorkspace = process.cwd();
		const otherWorkspace = await mkdtemp(join(tmpdir(), "mu-list-threads-workspace-other-"));

		await writeSession({
			configDir,
			workspaceDir: currentWorkspace,
			sessionId: "current-workspace",
			firstUserText: "auth login issue",
			fileName: "2026-01-01T00-00-00-000Z_current-workspace.jsonl",
		});
		await writeSession({
			configDir,
			workspaceDir: otherWorkspace,
			sessionId: "other-workspace",
			firstUserText: "billing invoice issue",
			fileName: "2026-01-01T00-00-01-000Z_other-workspace.jsonl",
		});

		const defaultPayload = await listThreads({ limit: 10 });
		const globalSearchPayload = await listThreads({ workspace: "global", search: "billing", limit: 10 });
		const substringPayload = await listThreads({ workspace: "invoice", limit: 10 });

		expect(defaultPayload.map((entry) => entry.id)).toEqual(["current-workspace"]);
		expect(globalSearchPayload.map((entry) => entry.id)).toEqual(["other-workspace"]);
		expect(substringPayload).toEqual([]);
	});
});
