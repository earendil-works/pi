import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type {
	MarkdownMessageMeta,
	MarkdownTransformContext,
	MarkdownTransformer,
} from "../../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import type { SessionEntry, SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import type { UserMessageComponent } from "../../../src/modes/interactive/components/user-message.ts";
import {
	InteractiveMode,
	type RenderSessionItem,
	sessionEntriesToRenderItems,
} from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const EMPTY_USAGE: Usage = {
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
};

function createUserMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMessageEntry(message: AgentMessage, id: string, timestamp: string): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp, message };
}

type FakeThis = {
	chatContainer: Container;
	pendingTools: Map<string, ToolExecutionComponent>;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowCacheMissNotices(): boolean;
		getCodeBlockIndent(): number;
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: {
		retryAttempt: number;
		modelRuntime: undefined;
		extensionRunner: { getMarkdownTransformers(): MarkdownTransformer[] };
	};
	toolOutputExpanded: boolean;
	outputPad: number;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(): undefined;
	mermaidMarkdownTransformer: MarkdownTransformer;
	maybeShowCacheMissNotice(): void;
	lastUserMessageComponent?: UserMessageComponent;
	lastAssistantComponent?: AssistantMessageComponent;
	streamingComponent?: AssistantMessageComponent;
	streamingMessage?: AssistantMessage;
	updatePendingMessagesDisplay(): void;
	getUserMessageText(message: Message): string;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getMarkdownTransformers(): MarkdownTransformer[];
	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; entryMeta?: MarkdownMessageMeta },
	): void;
	renderSessionItems(
		items: readonly RenderSessionItem[],
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void;
	renderSessionEntries(entries: SessionEntry[], options?: { updateFooter?: boolean; populateHistory?: boolean }): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
};

function createFakeThis(capturedContexts: MarkdownTransformContext[]): FakeThis {
	const chatContainer = new Container();
	const captureTransformer: MarkdownTransformer = (markdown, context) => {
		capturedContexts.push(context);
		return markdown;
	};
	const prototype = InteractiveMode.prototype as unknown as FakeThis;
	return {
		chatContainer,
		pendingTools: new Map<string, ToolExecutionComponent>(),
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
			getCodeBlockIndent: () => 4,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: {
			retryAttempt: 0,
			modelRuntime: undefined,
			extensionRunner: { getMarkdownTransformers: () => [captureTransformer] },
		},
		toolOutputExpanded: false,
		outputPad: 1,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: () => undefined,
		mermaidMarkdownTransformer: (markdown) => markdown,
		maybeShowCacheMissNotice: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		getUserMessageText: prototype.getUserMessageText,
		getMarkdownThemeWithSettings: prototype.getMarkdownThemeWithSettings,
		getMarkdownTransformers: prototype.getMarkdownTransformers,
		addMessageToChat: prototype.addMessageToChat,
		renderSessionItems: prototype.renderSessionItems,
		renderSessionEntries: prototype.renderSessionEntries,
		handleEvent: prototype.handleEvent,
	};
}

describe("markdown transformer message identity (#7828)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("sessionEntriesToRenderItems carries entry identity with each message", () => {
		const entry = createMessageEntry(createUserMessage("hello"), "entry-user", "2025-01-15T10:30:00.000Z");
		const items = sessionEntriesToRenderItems([entry]);

		expect(items).toEqual([
			{
				kind: "message",
				message: entry.message,
				entryMeta: { messageId: "entry-user", timestamp: "2025-01-15T10:30:00.000Z" },
			},
		]);
	});

	test("persisted user entry renders with exact entry id + timestamp", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const fakeThis = createFakeThis(capturedContexts);
		const entry = createMessageEntry(createUserMessage("hello"), "entry-user", "2025-01-15T10:30:00.000Z");

		fakeThis.renderSessionEntries.call(fakeThis, [entry]);
		fakeThis.chatContainer.render(80);

		expect(capturedContexts).toHaveLength(1);
		expect(capturedContexts[0]).toMatchObject({
			messageType: "user",
			isStreaming: false,
			messageId: "entry-user",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});

	test("persisted assistant entry renders with exact entry id + timestamp, including thinking markdown", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const fakeThis = createFakeThis(capturedContexts);
		const message = createAssistantMessage([
			{ type: "text", text: "answer text" },
			{ type: "thinking", thinking: "thought process" },
		]);
		const entry = createMessageEntry(message, "entry-assistant", "2025-06-15T14:00:00.000Z");

		fakeThis.renderSessionEntries.call(fakeThis, [entry]);
		fakeThis.chatContainer.render(80);

		const byType = new Map(capturedContexts.map((ctx) => [ctx.messageType, ctx]));
		expect(byType.get("assistant")).toMatchObject({
			messageId: "entry-assistant",
			timestamp: "2025-06-15T14:00:00.000Z",
		});
		expect(byType.get("assistant-thinking")).toMatchObject({
			messageId: "entry-assistant",
			timestamp: "2025-06-15T14:00:00.000Z",
		});
	});

	test("rebuilding the same transcript does not change canonical messageId", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const fakeThis = createFakeThis(capturedContexts);
		const entry = createMessageEntry(createUserMessage("hello"), "entry-user", "2025-01-15T10:30:00.000Z");

		fakeThis.renderSessionEntries.call(fakeThis, [entry]);
		fakeThis.chatContainer.render(80);
		const firstIds = capturedContexts.map((ctx) => ctx.messageId);

		fakeThis.renderSessionEntries.call(fakeThis, [entry]);
		fakeThis.chatContainer.render(80);
		const secondIds = capturedContexts.slice(firstIds.length).map((ctx) => ctx.messageId);

		expect(secondIds).toEqual(firstIds);
		expect(secondIds).toEqual(["entry-user"]);
	});

	test("live user message gets entry identity via entry_appended after persistence", async () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const fakeThis = createFakeThis(capturedContexts);

		// Live path: message_start renders the component before any entry exists.
		await fakeThis.handleEvent.call(fakeThis, { type: "message_start", message: createUserMessage("hello") });
		expect(fakeThis.lastUserMessageComponent).toBeDefined();
		fakeThis.chatContainer.render(80);
		expect(capturedContexts.at(-1)?.messageId).toBeUndefined();

		// Persistence layer emits entry_appended with the real entry; handler attaches it.
		const entry = createMessageEntry(createUserMessage("hello"), "entry-user", "2025-01-15T10:30:00.000Z");
		await fakeThis.handleEvent.call(fakeThis, { type: "entry_appended", entry });
		fakeThis.chatContainer.render(80);

		expect(capturedContexts.at(-1)).toMatchObject({
			messageType: "user",
			messageId: "entry-user",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});

	test("live assistant message keeps transientId stable and gains entry identity via entry_appended", async () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const fakeThis = createFakeThis(capturedContexts);

		await fakeThis.handleEvent.call(fakeThis, {
			type: "message_start",
			message: createAssistantMessage([{ type: "text", text: "partial" }]),
		});
		fakeThis.chatContainer.render(80);
		expect(capturedContexts.at(-1)?.messageId).toBeUndefined();
		const transientId = capturedContexts.at(-1)?.transientId;
		expect(transientId).toBeDefined();

		// Streaming updates keep the same transient identity.
		await fakeThis.handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage([{ type: "text", text: "more" }]),
			assistantMessageEvent: {
				type: "done",
				reason: "stop",
				message: createAssistantMessage([{ type: "text", text: "more" }]),
			},
		});
		fakeThis.chatContainer.render(80);
		expect(capturedContexts.at(-1)?.transientId).toBe(transientId);

		// message_end finalizes the message, then entry_appended attaches the canonical entry id.
		await fakeThis.handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage([{ type: "text", text: "final" }]),
		});
		expect(fakeThis.lastAssistantComponent).toBeDefined();
		const entry = createMessageEntry(
			createAssistantMessage([{ type: "text", text: "final" }]),
			"entry-assistant",
			"2025-06-15T14:00:00.000Z",
		);
		await fakeThis.handleEvent.call(fakeThis, { type: "entry_appended", entry });
		fakeThis.chatContainer.render(80);

		expect(capturedContexts.at(-1)).toMatchObject({
			messageType: "assistant",
			messageId: "entry-assistant",
			timestamp: "2025-06-15T14:00:00.000Z",
		});
		expect(capturedContexts.at(-1)?.transientId).toBe(transientId);
	});
});

describe("AgentSession emits entry_appended for persisted messages (#7828)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost() {
		const tempDir = join(tmpdir(), `pi-7828-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost };
	}

	test("persists user and assistant messages and emits entry_appended with the real entry", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const appended: SessionMessageEntry[] = [];
		runtimeHost.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "message") {
				appended.push(event.entry);
			}
		});

		await runtimeHost.session.prompt("hello");

		const roles = appended.map((entry) => entry.message.role);
		expect(roles).toEqual(["user", "assistant"]);

		// The emitted entry is the real persisted entry: same id and timestamp
		// as what the session manager holds, so rebuilt rendering is identical.
		for (const entry of appended) {
			expect(entry.id).toBeTruthy();
			const persisted = runtimeHost.session.sessionManager.getEntry(entry.id);
			expect(persisted).toBeDefined();
			expect(persisted?.timestamp).toBe(entry.timestamp);
		}
	});
});
