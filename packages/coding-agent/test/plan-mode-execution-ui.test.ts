import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { loadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionActions, ExtensionContextActions, ExtensionUIContext } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mockTheme = {
	fg: (_key: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function assistantTextMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("plan-mode execution UI", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-execution-ui-"));
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.inMemory(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps execution todo rendering in the widget and hides execution dispatch messages", async () => {
		const extPath = path.resolve(__dirname, "../examples/extensions/plan-mode");
		const result = await loadExtensions([extPath], tempDir);
		expect(result.errors).toHaveLength(0);

		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		const sentMessages: Array<{ message: any; options: any }> = [];
		const widgets = new Map<string, string[] | undefined>();
		const widgetOptions = new Map<string, unknown>();

		const uiContext: ExtensionUIContext = {
			select: async (prompt, options) => {
				if (prompt === "Plan generated — what next?") return "Start Work";
				return options[0];
			},
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: ((id, lines, options) => {
				widgets.set(id, lines as string[] | undefined);
				widgetOptions.set(id, options);
			}) as ExtensionUIContext["setWidget"],
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => {},
			get theme() {
				return mockTheme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};

		const extensionActions: ExtensionActions = {
			sendMessage: (message, options) => {
				sentMessages.push({ message, options });
			},
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

		runner.setUIContext(uiContext);
		runner.bindCore(extensionActions, extensionContextActions);

		await runner.emitBeforeAgentStart("fix typo", undefined, "base prompt");

		const planText = `# Plan: fix typo

## TODOs
- [ ] 1. Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget
- [ ] 2. Render candidate pagination UI and visible count text without shortening the todo label`;

		await runner.emit({
			type: "agent_end",
			messages: [assistantTextMessage(planText)],
		});

		const executionDispatch = sentMessages.find((entry) => entry.message.customType === "plan-mode-execute");
		expect(executionDispatch).toBeDefined();
		expect(executionDispatch!.message.display).toBe(false);
		expect(executionDispatch!.options).toEqual({ triggerTurn: true });

		const widgetLines = widgets.get("plan-todos");
		expect(widgetLines).toBeDefined();
		expect(widgetLines!.join("\n")).toContain("Executing Plan");
		expect(widgetLines!.join("\n")).toContain(
			"Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget",
		);
		expect(widgetLines!.join("\n")).toContain(
			"Render candidate pagination UI and visible count text without shortening the todo label",
		);
		expect(widgetLines!.join("\n")).not.toContain("...");
		expect(widgetOptions.get("plan-todos")).toEqual(expect.objectContaining({ maxLines: null }));
	});

	it("rehydrates old execution sessions with full todo labels on session start", async () => {
		const extPath = path.resolve(__dirname, "../examples/extensions/plan-mode");
		const result = await loadExtensions([extPath], tempDir);
		expect(result.errors).toHaveLength(0);

		sessionManager.appendCustomEntry("plan-mode", {
			phase: "execution",
			userPrompt: "fix typo",
			planText: `# Recruitment

## TODOs

- [ ] 1. Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget
- [ ] 2. Render candidate pagination UI and visible count text without shortening the todo label`,
			todoItems: [
				{
					step: 1,
					text: "Wire candidate page state into the recruitment ...",
					completed: false,
				},
				{
					step: 2,
					text: "Render candidate pagination UI and visible count...",
					completed: false,
				},
			],
			currentWaveIndex: 0,
			waves: [{ wave: 1, steps: [1, 2] }],
		});

		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		const widgets = new Map<string, string[] | undefined>();

		const uiContext: ExtensionUIContext = {
			select: async (_prompt, options) => options[0],
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: ((id, lines) => {
				widgets.set(id, lines as string[] | undefined);
			}) as ExtensionUIContext["setWidget"],
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => {},
			get theme() {
				return mockTheme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};

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

		runner.setUIContext(uiContext);
		runner.bindCore(extensionActions, extensionContextActions);

		await runner.emit({ type: "session_start", reason: "startup" });

		const widgetLines = widgets.get("plan-todos");
		expect(widgetLines).toBeDefined();
		expect(widgetLines!.join("\n")).toContain(
			"Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget",
		);
		expect(widgetLines!.join("\n")).toContain(
			"Render candidate pagination UI and visible count text without shortening the todo label",
		);
		expect(widgetLines!.join("\n")).not.toContain("recruitment ...");
		expect(widgetLines!.join("\n")).not.toContain("visible count...");
	});
});
