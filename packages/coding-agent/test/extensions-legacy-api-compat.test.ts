import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("extensions legacy API compatibility", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-legacy-ext-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		modelRegistry = ModelRegistry.create(AuthStorage.create(path.join(tempDir, "auth.json")));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("maps legacy command:new hook to session_before_switch reason=new", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerHook("command:new", async () => {
					pi.registerCommand("from-legacy-hook", {
						description: "registered during legacy hook",
						handler: async () => {},
					});
				}, { name: "legacy.new", description: "legacy hook mapping" });
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "legacy-hook.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toEqual([]);

		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		expect(runner.getCommand("from-legacy-hook")).toBeUndefined();

		await runner.emit({
			type: "session_before_switch",
			reason: "resume",
		});
		expect(runner.getCommand("from-legacy-hook")).toBeUndefined();

		await runner.emit({
			type: "session_before_switch",
			reason: "new",
		});
		expect(runner.getCommand("from-legacy-hook")).toBeDefined();
	});

	it("maps legacy before_tool_call hook result to tool_call blocking result", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerHook("before_tool_call", async (event) => {
					if (event && event.params && event.params.command === "blocked") {
						return { block: true, blockReason: "legacy blocked command" };
					}
					return undefined;
				}, { name: "legacy.before_tool_call", description: "legacy tool hook mapping" });
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "legacy-before-tool.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toEqual([]);

		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		const blocked = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "tool-1",
			input: { command: "blocked" },
		});
		expect(blocked).toEqual({
			block: true,
			reason: "legacy blocked command",
		});

		const passthrough = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "tool-2",
			input: { command: "echo ok" },
		});
		expect(passthrough).toBeUndefined();
	});

	it("supports legacy object-style registerCommand and adapts text result output", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerCommand({
					name: "legacy-object-command",
					description: "legacy object command",
					handler: async ({ args }) => ({ text: "legacy:" + (args || "") }),
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "legacy-object-command.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toEqual([]);

		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		const sendMessageSpy = vi.fn();
		runner.bindCore({ ...extensionActions, sendMessage: sendMessageSpy }, extensionContextActions);

		const command = runner.getCommand("legacy-object-command");
		expect(command).toBeDefined();
		await command?.handler("hello", runner.createCommandContext());

		expect(sendMessageSpy).toHaveBeenCalledWith(
			{
				customType: "legacy-command:legacy-object-command",
				content: "legacy:hello",
				display: true,
			},
			{ triggerTurn: false },
		);
	});

	it("accepts legacy registerContextEngine with ownsCompaction=false", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerContextEngine("legacy-context-engine", () => ({
					info: { id: "legacy-context-engine", name: "Legacy Engine", ownsCompaction: false },
					ingest: async () => ({ ingested: true }),
					assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
					compact: async () => ({ ok: true, compacted: false }),
				}));
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "legacy-context-engine.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toEqual([]);

		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		expect(runner.hasHandlers("session_before_compact")).toBe(true);
	});

	it("fails loudly for legacy registerContextEngine with ownsCompaction=true", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerContextEngine("legacy-context-engine", () => ({
					info: { id: "legacy-context-engine", name: "Legacy Engine", ownsCompaction: true },
					ingest: async () => ({ ingested: true }),
					assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
					compact: async () => ({ ok: true, compacted: true }),
				}));
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "legacy-context-engine-unsupported.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.extensions).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("ownsCompaction=true is not supported");
	});
});
