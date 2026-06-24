import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function createUiContext(
	onNotify: (message: string, type: "info" | "warning" | "error" | undefined) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: onNotify,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

type RebindContext = {
	unsubscribe?: () => void;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	subscribeToAgent: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type ReloadCommandContext = {
	hideThinkingBlock: boolean;
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		reload: (options?: { beforeSessionStart?: () => void | Promise<void> }) => Promise<void>;
		resourceLoader: { getThemes: () => { themes: [] } };
		extensionRunner: unknown;
		modelRegistry: { getError: () => string | undefined };
	};
	settingsManager: {
		getHttpIdleTimeoutMs: () => number;
		getHideThinkingBlock: () => boolean;
		getEditorPaddingX: () => number;
		getAutocompleteMaxVisible: () => number;
		getShowHardwareCursor: () => boolean;
		getClearOnShrink: () => boolean;
	};
	keybindings: { reload: () => void };
	customHeader?: unknown;
	builtInHeader?: unknown;
	editorContainer: { clear: () => void; addChild: (component: unknown) => void };
	ui: {
		setFocus: (component: unknown) => void;
		requestRender: (force?: boolean) => void;
		setShowHardwareCursor: (enabled: boolean) => void;
		setClearOnShrink: (enabled: boolean) => void;
	};
	editor: unknown;
	defaultEditor: { setPaddingX: (padding: number) => void; setAutocompleteMaxVisible: (maxVisible: number) => void };
	themeController: { applyFromSettings: () => Promise<void> };
	resetExtensionUI: () => void;
	rebuildChatFromMessages: () => void;
	setupAutocompleteProvider: () => void;
	setupExtensionShortcuts: (runner: unknown) => void;
	showLoadedResources: (options: unknown) => void;
	maybeSaveImplicitProjectTrustAfterReload: () => boolean;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
	handleReloadCommand(this: ReloadCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type ReloadCommandContextOverrides = Omit<
	Partial<ReloadCommandContext>,
	"session" | "settingsManager" | "keybindings" | "editorContainer" | "ui" | "defaultEditor" | "themeController"
> & {
	session?: Partial<ReloadCommandContext["session"]>;
	settingsManager?: Partial<ReloadCommandContext["settingsManager"]>;
	keybindings?: Partial<ReloadCommandContext["keybindings"]>;
	editorContainer?: Partial<ReloadCommandContext["editorContainer"]>;
	ui?: Partial<ReloadCommandContext["ui"]>;
	defaultEditor?: Partial<ReloadCommandContext["defaultEditor"]>;
	themeController?: Partial<ReloadCommandContext["themeController"]>;
};

function createReloadCommandContext(overrides: ReloadCommandContextOverrides = {}): ReloadCommandContext {
	const editor = overrides.editor ?? {};
	return {
		hideThinkingBlock: overrides.hideThinkingBlock ?? false,
		session: {
			isStreaming: false,
			isCompacting: false,
			reload: async (options) => {
				await options?.beforeSessionStart?.();
			},
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			extensionRunner: {},
			modelRegistry: { getError: () => undefined },
			...overrides.session,
		},
		settingsManager: {
			getHttpIdleTimeoutMs: () => 0,
			getHideThinkingBlock: () => false,
			getEditorPaddingX: () => 1,
			getAutocompleteMaxVisible: () => 10,
			getShowHardwareCursor: () => false,
			getClearOnShrink: () => false,
			...overrides.settingsManager,
		},
		keybindings: { reload: () => {}, ...overrides.keybindings },
		editorContainer: { clear: () => {}, addChild: () => {}, ...overrides.editorContainer },
		ui: {
			setFocus: () => {},
			requestRender: () => {},
			setShowHardwareCursor: () => {},
			setClearOnShrink: () => {},
			...overrides.ui,
		},
		editor,
		defaultEditor: { setPaddingX: () => {}, setAutocompleteMaxVisible: () => {}, ...overrides.defaultEditor },
		themeController: { applyFromSettings: async () => {}, ...overrides.themeController },
		customHeader: overrides.customHeader,
		builtInHeader: overrides.builtInHeader,
		resetExtensionUI: overrides.resetExtensionUI ?? (() => {}),
		rebuildChatFromMessages: overrides.rebuildChatFromMessages ?? (() => {}),
		setupAutocompleteProvider: overrides.setupAutocompleteProvider ?? (() => {}),
		setupExtensionShortcuts: overrides.setupExtensionShortcuts ?? (() => {}),
		showLoadedResources: overrides.showLoadedResources ?? (() => {}),
		maybeSaveImplicitProjectTrustAfterReload: overrides.maybeSaveImplicitProjectTrustAfterReload ?? (() => false),
		showStatus: overrides.showStatus ?? (() => {}),
		showWarning: overrides.showWarning ?? (() => {}),
		showError: overrides.showError ?? (() => {}),
	};
}

type MessageEvent = Extract<AgentSessionEvent, { type: "message_start" | "message_end" }>;

function getMessageText(event: MessageEvent): string {
	const message = event.message;
	if (!("content" in message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

describe("regression #5943: session_start transient UI", () => {
	it("renders replacement session state before session_start handlers can notify", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.notify("Hello Error", "error");
					});
				},
			],
		});

		try {
			const context: RebindContext = {
				applyRuntimeSettings: () => events.push("apply"),
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext((message) => events.push(`notify:${message}`)),
						mode: "tui",
					});
				},
				subscribeToAgent: () => events.push("subscribe"),
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });

			expect(events).toEqual(["apply", "render", "subscribe", "bind", "notify:Hello Error"]);
		} finally {
			harness.cleanup();
		}
	});

	it("subscribes before replacement session_start handlers send messages", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendMessage({
							customType: "session-start",
							content: "custom from start",
							display: true,
						});
					});
				},
			],
		});

		try {
			const context: RebindContext = {
				applyRuntimeSettings: () => {},
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext(() => {}),
						mode: "tui",
					});
				},
				subscribeToAgent: () => {
					events.push("subscribe");
					harness.session.subscribe((event) => {
						if (event.type !== "message_start" && event.type !== "message_end") {
							return;
						}
						events.push(`${event.type}:${event.message.role}:${getMessageText(event)}`);
					});
				},
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });

			expect(events).toEqual([
				"render",
				"subscribe",
				"bind",
				"message_start:custom:custom from start",
				"message_end:custom:custom from start",
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("subscribes before replacement session_start handlers send user messages", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.sendUserMessage("user from start");
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("assistant from start")]);

		try {
			const context: RebindContext = {
				applyRuntimeSettings: () => {},
				renderCurrentSessionState: () => events.push("render"),
				bindCurrentSessionExtensions: async () => {
					events.push("bind");
					await harness.session.bindExtensions({
						uiContext: createUiContext(() => {}),
						mode: "tui",
					});
				},
				subscribeToAgent: () => {
					events.push("subscribe");
					harness.session.subscribe((event) => {
						if (event.type !== "message_start" && event.type !== "message_end") {
							return;
						}
						events.push(`${event.type}:${event.message.role}:${getMessageText(event)}`);
					});
				},
				updateAvailableProviderCount: async () => {},
				updateEditorBorderColor: () => {},
				updateTerminalTitle: () => {},
			};

			await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });
			await harness.session.agent.waitForIdle();

			expect(events.slice(0, 3)).toEqual(["render", "subscribe", "bind"]);
			expect(events).toContain("message_start:user:user from start");
			expect(events).toContain("message_end:user:user from start");
			expect(events).toContain("message_end:assistant:assistant from start");
		} finally {
			harness.cleanup();
		}
	});

	it("runs the reload render hook before reload session_start handlers can notify", async () => {
		const events: string[] = [];
		const beforeSessionStart = vi.fn(() => {
			events.push("render");
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event, ctx) => {
						events.push(`start:${event.reason}`);
						ctx.ui.notify(`notify:${event.reason}`, "error");
					});
				},
			],
		});

		try {
			await harness.session.bindExtensions({
				uiContext: createUiContext((message) => events.push(message)),
				mode: "tui",
			});
			expect(events).toEqual(["start:startup", "notify:startup"]);

			events.length = 0;
			await harness.session.reload({ beforeSessionStart });

			expect(beforeSessionStart).toHaveBeenCalledTimes(1);
			expect(events).toEqual(["render", "start:reload", "notify:reload"]);
		} finally {
			harness.cleanup();
		}
	});

	it("refreshes hideThinkingBlock before rebuilding chat during reload", async () => {
		initTheme("dark", false);
		const events: string[] = [];
		let context: ReloadCommandContext;
		context = createReloadCommandContext({
			settingsManager: { getHideThinkingBlock: () => true },
			session: {
				reload: async (options) => {
					events.push("reload");
					await options?.beforeSessionStart?.();
					events.push(`start:${context.hideThinkingBlock}`);
				},
			},
			rebuildChatFromMessages: () => {
				events.push(`rebuild:${context.hideThinkingBlock}`);
			},
		});

		await interactiveModePrototype.handleReloadCommand.call(context);

		expect(context.hideThinkingBlock).toBe(true);
		expect(events).toEqual(["reload", "rebuild:true", "start:true"]);
	});

	it("keeps the reload blocker focused until async reload completes", async () => {
		initTheme("dark", false);
		const editor = {};
		let focused: unknown;
		let chatRestored = false;
		let markReloadWaiting!: () => void;
		let finishReload!: () => void;
		const reloadWaiting = new Promise<void>((resolve) => {
			markReloadWaiting = resolve;
		});
		const reloadFinished = new Promise<void>((resolve) => {
			finishReload = resolve;
		});

		const context = createReloadCommandContext({
			editor,
			session: {
				reload: async (options) => {
					await options?.beforeSessionStart?.();
					markReloadWaiting();
					await reloadFinished;
				},
			},
			ui: {
				setFocus: (component) => {
					focused = component;
				},
			},
			rebuildChatFromMessages: () => {
				chatRestored = true;
			},
		});

		const reloadPromise = interactiveModePrototype.handleReloadCommand.call(context);
		await reloadWaiting;

		expect(chatRestored).toBe(true);
		expect(focused).not.toBe(editor);

		finishReload();
		await reloadPromise;

		expect(focused).toBe(editor);
	});
});
