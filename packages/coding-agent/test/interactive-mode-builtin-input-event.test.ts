import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type BuiltinInputEventContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		extensionRunner: {
			hasHandlers: (event: string) => boolean;
			emitInput: (
				text: string,
				images: undefined,
				source: string,
				streamingBehavior: undefined,
			) => Promise<{ action: string }>;
		};
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	showSettingsSelector: () => void;
	showModelsSelector: () => Promise<void>;
	handleShareCommand: () => Promise<void>;
	handleExportCommand: (text: string) => Promise<void>;
	handleImportCommand: (text: string) => Promise<void>;
	handleModelCommand: (searchTerm?: string, options?: unknown) => Promise<void>;
	handleCopyCommand: (options?: unknown) => Promise<void>;
	handleNameCommand: (text: string) => void;
	handleSessionCommand: () => void;
	handleChangelogCommand: () => void;
	handleHotkeysCommand: () => void;
	handleCloneCommand: () => Promise<void>;
	handleClearCommand: () => Promise<void>;
	handleReloadCommand: () => Promise<void>;
	handleLoginCommand: (providerRef?: string) => Promise<void>;
	handleCompactCommand: (instructions?: string) => Promise<void>;
	handleBashCommand: (command: string, excludeFromContext: boolean) => Promise<void>;
	showUserMessageSelector: () => void;
	showTreeSelector: () => void;
	showTrustSelector: () => void;
	showOAuthSelector: (mode: string) => void;
	showSessionSelector: () => void;
	handleDebugCommand: () => void;
	handleArminSaysHi: () => void;
	handleDementedDelves: () => void;
	isExtensionCommand: (text: string) => boolean;
	isBashMode: boolean;
	updateEditorBorderColor: () => void;
	updatePendingMessagesDisplay: () => void;
	pendingMessagesContainer: { addChild: () => void };
	pendingBashComponents: unknown[];
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	settingsManager: { getEnableSkillCommands: () => boolean };
	sessionManager: { getCwd: () => string };
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: BuiltinInputEventContext): void;
};

const proto = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createContext(overrides?: Partial<BuiltinInputEventContext>): BuiltinInputEventContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			extensionRunner: {
				hasHandlers: vi.fn(() => false),
				emitInput: vi.fn(async () => ({ action: "continue" })),
			},
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		showSettingsSelector: vi.fn(),
		showModelsSelector: vi.fn(async () => {}),
		handleShareCommand: vi.fn(async () => {}),
		handleExportCommand: vi.fn(async () => {}),
		handleImportCommand: vi.fn(async () => {}),
		handleModelCommand: vi.fn(async () => {}),
		handleCopyCommand: vi.fn(async () => {}),
		handleNameCommand: vi.fn(),
		handleSessionCommand: vi.fn(),
		handleChangelogCommand: vi.fn(),
		handleHotkeysCommand: vi.fn(),
		handleCloneCommand: vi.fn(async () => {}),
		handleClearCommand: vi.fn(async () => {}),
		handleReloadCommand: vi.fn(async () => {}),
		handleLoginCommand: vi.fn(async () => {}),
		handleCompactCommand: vi.fn(async () => {}),
		handleBashCommand: vi.fn(async () => {}),
		showUserMessageSelector: vi.fn(),
		showTreeSelector: vi.fn(),
		showTrustSelector: vi.fn(),
		showOAuthSelector: vi.fn(),
		showSessionSelector: vi.fn(),
		handleDebugCommand: vi.fn(),
		handleArminSaysHi: vi.fn(),
		handleDementedDelves: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		isBashMode: false,
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		pendingMessagesContainer: { addChild: vi.fn() },
		pendingBashComponents: [],
		onInputCallback: undefined,
		pendingUserInputs: [],
		settingsManager: { getEnableSkillCommands: () => true },
		sessionManager: { getCwd: () => "/tmp" },
		...overrides,
	};
}

describe("InteractiveMode builtin slash command input event", () => {
	it("emits input event for /share and blocks when extension returns handled", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(ctx.session.extensionRunner.emitInput as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "handled" });

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/share");

		expect(ctx.session.extensionRunner.emitInput).toHaveBeenCalledWith("/share", undefined, "interactive", undefined);
		expect(ctx.handleShareCommand).not.toHaveBeenCalled();
		expect(ctx.editor.setText).toHaveBeenCalledWith("");
	});

	it("emits input event for /export and blocks when extension returns handled", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(ctx.session.extensionRunner.emitInput as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "handled" });

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/export");

		expect(ctx.session.extensionRunner.emitInput).toHaveBeenCalledWith(
			"/export",
			undefined,
			"interactive",
			undefined,
		);
		expect(ctx.handleExportCommand).not.toHaveBeenCalled();
		expect(ctx.editor.setText).toHaveBeenCalledWith("");
	});

	it("emits input event for /settings and blocks when extension returns handled", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(ctx.session.extensionRunner.emitInput as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "handled" });

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/settings");

		expect(ctx.session.extensionRunner.emitInput).toHaveBeenCalledWith(
			"/settings",
			undefined,
			"interactive",
			undefined,
		);
		expect(ctx.showSettingsSelector).not.toHaveBeenCalled();
	});

	it("proceeds with /share when extension returns continue", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(ctx.session.extensionRunner.emitInput as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "continue" });

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/share");

		expect(ctx.session.extensionRunner.emitInput).toHaveBeenCalledWith("/share", undefined, "interactive", undefined);
		expect(ctx.handleShareCommand).toHaveBeenCalled();
	});

	it("proceeds with /export when extension returns continue", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(ctx.session.extensionRunner.emitInput as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "continue" });

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/export session.html");

		expect(ctx.session.extensionRunner.emitInput).toHaveBeenCalledWith(
			"/export session.html",
			undefined,
			"interactive",
			undefined,
		);
		expect(ctx.handleExportCommand).toHaveBeenCalledWith("/export session.html");
	});

	it("does not emit input event when no handlers are registered", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(false);

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/share");

		expect(ctx.session.extensionRunner.emitInput).not.toHaveBeenCalled();
		expect(ctx.handleShareCommand).toHaveBeenCalled();
	});

	it("does not emit input event for non-builtin slash commands", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);

		proto.setupEditorSubmitHandler.call(ctx);
		// /my-extension-command is not a builtin — it should NOT trigger emitInput here
		// (it flows through session.prompt() later which has its own emitInput)
		await ctx.defaultEditor.onSubmit!("/my-extension-command");

		expect(ctx.session.extensionRunner.emitInput).not.toHaveBeenCalled();
	});

	it("does not emit input event for non-slash text", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("hello world");

		expect(ctx.session.extensionRunner.emitInput).not.toHaveBeenCalled();
	});

	it("passes full text including arguments to emitInput", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(ctx.session.extensionRunner.emitInput as ReturnType<typeof vi.fn>).mockResolvedValue({ action: "continue" });

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/model anthropic/claude-sonnet-4");

		expect(ctx.session.extensionRunner.emitInput).toHaveBeenCalledWith(
			"/model anthropic/claude-sonnet-4",
			undefined,
			"interactive",
			undefined,
		);
	});

	it("handles transform result by proceeding with original text (no transformation for builtins)", async () => {
		const ctx = createContext();
		(ctx.session.extensionRunner.hasHandlers as ReturnType<typeof vi.fn>).mockReturnValue(true);
		// transform is treated as "not handled" — the builtin dispatch uses the original text
		(ctx.session.extensionRunner.emitInput as ReturnType<typeof vi.fn>).mockResolvedValue({
			action: "transform",
			text: "something else",
		});

		proto.setupEditorSubmitHandler.call(ctx);
		await ctx.defaultEditor.onSubmit!("/share");

		// transform !== "handled", so the command proceeds
		expect(ctx.handleShareCommand).toHaveBeenCalled();
	});
});
