/**
 * Tests for the /init extension wiring (plus/src/extensions/init/index.ts):
 * the command sends the create prompt when AGENTS.md is missing, the improve
 * prompt when it exists, and registers no context-file handler — upstream
 * already loads AGENTS.md into the system prompt itself.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../coding-agent/src/core/extensions/types.ts";
import { registerInit } from "../../src/extensions/init/index.ts";

interface CommandLike {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface Harness {
	commands: Map<string, CommandLike>;
	events: string[];
	sentMessages: string[];
	notifications: string[];
	projectDir: string;
	agentsMdPath: string;
	ctx: ExtensionCommandContext;
	runInit(): Promise<void>;
}

function harness(agentsMdContent?: string): Harness {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-init-ext-"));
	const projectDir = path.join(base, "project");
	fs.mkdirSync(projectDir, { recursive: true });
	const agentsMdPath = path.join(projectDir, "AGENTS.md");
	if (agentsMdContent !== undefined) {
		fs.writeFileSync(agentsMdPath, agentsMdContent, "utf8");
	}

	const commands = new Map<string, CommandLike>();
	const events: string[] = [];
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
		on: (event: string) => {
			events.push(event);
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

	return { commands, events, sentMessages, notifications, projectDir, agentsMdPath, ctx, runInit };
}

describe("init extension wiring", () => {
	it("registers the /init command and no event handlers", () => {
		const h = harness();
		assert.ok(h.commands.has("init"));
		// Upstream's context loader reads AGENTS.md itself; injecting it from an
		// extension would double-load it and override --no-context-files.
		assert.deepEqual(h.events, []);
	});

	it("sends the create prompt targeting <cwd>/AGENTS.md when AGENTS.md is missing", async () => {
		const h = harness();
		await h.runInit();
		assert.equal(h.sentMessages.length, 1);
		assert.ok(h.sentMessages[0].includes(h.agentsMdPath));
		assert.ok(h.sentMessages[0].includes("# AGENTS.md"));
		assert.ok(h.notifications.some((n) => n.includes("create")));
	});

	it("sends the improve prompt instead when AGENTS.md already exists", async () => {
		const h = harness("# AGENTS.md\n\nRun tests with `npm test`.\n");
		await h.runInit();
		assert.equal(h.sentMessages.length, 1);
		assert.ok(h.sentMessages[0].includes("suggest specific improvements"));
		assert.ok(h.sentMessages[0].includes("npm test"));
		assert.ok(h.notifications.some((n) => n.includes("exists")));
	});

	it("ignores an AGENTS.md directory rather than a file", async () => {
		const h = harness();
		fs.mkdirSync(h.agentsMdPath);
		await h.runInit();
		assert.equal(h.sentMessages.length, 1);
		assert.ok(h.sentMessages[0].includes(h.agentsMdPath));
		assert.ok(h.sentMessages[0].includes("create an AGENTS.md"));
	});
});
