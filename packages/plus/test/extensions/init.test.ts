/**
 * Tests for the /init extension wiring (plus/src/extensions/init/index.ts):
 * the command sends the create prompt when PI.md is missing, the improve
 * prompt when it exists, and the before_agent_start handler appends PI.md to
 * the system prompt's context files (idempotently).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
} from "../../../coding-agent/src/core/extensions/types.ts";
import { registerInit } from "../../src/extensions/init/index.ts";

interface CommandLike {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface Harness {
	commands: Map<string, CommandLike>;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	sentMessages: string[];
	notifications: string[];
	projectDir: string;
	piMdPath: string;
	ctx: ExtensionCommandContext;
	runInit(): Promise<void>;
	fireBeforeAgentStart(): Promise<BeforeAgentStartEvent>;
}

function harness(piMdContent?: string): Harness {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-ext-"));
	const projectDir = path.join(base, "project");
	fs.mkdirSync(projectDir, { recursive: true });
	const piMdPath = path.join(projectDir, "PI.md");
	if (piMdContent !== undefined) {
		fs.writeFileSync(piMdPath, piMdContent, "utf8");
	}

	const commands = new Map<string, CommandLike>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sentMessages: string[] = [];
	const notifications: string[] = [];

	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
		},
		cwd: projectDir,
	} as unknown as ExtensionCommandContext;

	registerInit({
		registerCommand: (name: string, command: CommandLike) => {
			commands.set(name, command);
		},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		sendUserMessage: (content: string) => {
			sentMessages.push(content);
		},
	} as unknown as ExtensionAPI);

	const runInit = async (): Promise<void> => {
		const command = commands.get("init");
		assert.ok(command, "the init command must be registered");
		await command.handler("", ctx);
	};

	const fireBeforeAgentStart = async (): Promise<BeforeAgentStartEvent> => {
		const handler = handlers.get("before_agent_start");
		assert.ok(handler, "the before_agent_start handler must be registered");
		const event = {
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions: { sections: {}, contextFiles: [] },
		} as unknown as BeforeAgentStartEvent;
		await handler(event, ctx);
		return event;
	};

	return { commands, handlers, sentMessages, notifications, projectDir, piMdPath, ctx, runInit, fireBeforeAgentStart };
}

describe("init extension wiring", () => {
	it("registers the /init command and the before_agent_start handler", () => {
		const h = harness();
		assert.ok(h.commands.has("init"));
		assert.ok(h.handlers.has("before_agent_start"));
	});

	it("sends the create prompt targeting <cwd>/PI.md when PI.md is missing", async () => {
		const h = harness();
		await h.runInit();
		assert.equal(h.sentMessages.length, 1);
		assert.ok(h.sentMessages[0].includes(h.piMdPath));
		assert.ok(h.sentMessages[0].includes("# PI.md"));
		assert.ok(h.notifications.some((n) => n.includes("create")));
	});

	it("sends the improve prompt instead when PI.md already exists", async () => {
		const h = harness("# PI.md\n\nRun tests with `npm test`.\n");
		await h.runInit();
		assert.equal(h.sentMessages.length, 1);
		assert.ok(h.sentMessages[0].includes("suggest specific improvements"));
		assert.ok(h.sentMessages[0].includes("npm test"));
		assert.ok(h.notifications.some((n) => n.includes("exists")));
	});

	it("appends PI.md to the context files when it exists", async () => {
		const h = harness("# PI.md\n\nBuild: npm run build\n");
		const event = await h.fireBeforeAgentStart();
		const contextFiles = event.systemPromptOptions.contextFiles;
		assert.equal(contextFiles.length, 1);
		assert.equal(contextFiles[0].path, h.piMdPath);
		assert.ok(contextFiles[0].content.includes("npm run build"));
	});

	it("does not append PI.md twice across handler runs", async () => {
		const h = harness("# PI.md\n\ncontent\n");
		const first = await h.fireBeforeAgentStart();
		// Simulate a second turn on the same options object (upstream normally
		// rebuilds options per run; a duplicate guard keeps re-fires safe).
		const handler = h.handlers.get("before_agent_start");
		assert.ok(handler);
		await handler(first, h.ctx);
		assert.equal(first.systemPromptOptions.contextFiles.length, 1);
	});

	it("leaves the context files untouched when PI.md is missing", async () => {
		const h = harness();
		const event = await h.fireBeforeAgentStart();
		assert.equal(event.systemPromptOptions.contextFiles.length, 0);
	});

	it("ignores a PI.md directory rather than a file", async () => {
		const h = harness();
		fs.mkdirSync(h.piMdPath);
		const event = await h.fireBeforeAgentStart();
		assert.equal(event.systemPromptOptions.contextFiles.length, 0);
		await h.runInit();
		assert.equal(h.sentMessages.length, 1);
		assert.ok(h.sentMessages[0].includes(h.piMdPath));
	});
});
