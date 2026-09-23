import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	paintOptimisticUserMessage: (text: string) => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type PaintContext = {
	optimisticUserMessageText: string | undefined;
	chatContainer: { children: unknown[]; addChild: (c: unknown) => void; removeChild: (c: unknown) => void };
	ui: { requestRender: () => void };
	addMessageToChat: (message: unknown) => void;
	clearOptimisticUserMessageIfPending: () => void;
	getUserMessageText: (message: unknown) => string;
	removeTrailingOptimisticUserPaint: () => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	paintOptimisticUserMessage(this: PaintContext, text: string): void;
	reconcileOptimisticUserMessage(this: PaintContext, message: unknown): void;
	clearOptimisticUserMessageIfPending(this: PaintContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
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
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		paintOptimisticUserMessage: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("restores a prompt submitted while managed-tool setup is running", () => {
		const context: StartupSubmitContext = {
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
		};

		interactiveModePrototype.handleStartupSubmit.call(context, "early prompt");

		expect(context.editor.setText).toHaveBeenCalledWith("early prompt");
		expect(context.showStatus).toHaveBeenCalledWith("Startup is still in progress");
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.paintOptimisticUserMessage).toHaveBeenCalledWith("early prompt");
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("paints the user message before resolving the input callback", async () => {
		const paintOrder: string[] = [];
		const context = createSubmitContext();
		context.paintOptimisticUserMessage = vi.fn(() => {
			paintOrder.push("paint");
		});
		context.onInputCallback = vi.fn(() => {
			paintOrder.push("callback");
		});
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("hello paint");

		expect(paintOrder).toEqual(["paint", "callback"]);
		expect(context.paintOptimisticUserMessage).toHaveBeenCalledWith("hello paint");
		expect(context.onInputCallback).toHaveBeenCalledWith("hello paint");
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});

describe("InteractiveMode optimistic user paint", () => {
	it("requestRender immediately when painting an optimistic user message", () => {
		const context: PaintContext = {
			optimisticUserMessageText: undefined,
			chatContainer: { children: [], addChild: vi.fn(), removeChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			addMessageToChat: vi.fn(),
			clearOptimisticUserMessageIfPending: vi.fn(),
			getUserMessageText: vi.fn(),
			removeTrailingOptimisticUserPaint: vi.fn(),
		};

		interactiveModePrototype.paintOptimisticUserMessage.call(context, "visible now");

		expect(context.clearOptimisticUserMessageIfPending).toHaveBeenCalledTimes(1);
		expect(context.addMessageToChat).toHaveBeenCalledWith({
			role: "user",
			content: [{ type: "text", text: "visible now" }],
			timestamp: expect.any(Number),
		});
		expect(context.optimisticUserMessageText).toBe("visible now");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("skips duplicate add when message_start text matches the optimistic paint", () => {
		const context: PaintContext = {
			optimisticUserMessageText: "same text",
			chatContainer: { children: [], addChild: vi.fn(), removeChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			addMessageToChat: vi.fn(),
			clearOptimisticUserMessageIfPending: vi.fn(),
			getUserMessageText: vi.fn(() => "same text"),
			removeTrailingOptimisticUserPaint: vi.fn(),
		};

		interactiveModePrototype.reconcileOptimisticUserMessage.call(context, { role: "user" });

		expect(context.optimisticUserMessageText).toBeUndefined();
		expect(context.addMessageToChat).not.toHaveBeenCalled();
		expect(context.removeTrailingOptimisticUserPaint).not.toHaveBeenCalled();
	});

	it("replaces the optimistic bubble when message_start text differs", () => {
		const context: PaintContext = {
			optimisticUserMessageText: "typed",
			chatContainer: { children: [], addChild: vi.fn(), removeChild: vi.fn() },
			ui: { requestRender: vi.fn() },
			addMessageToChat: vi.fn(),
			clearOptimisticUserMessageIfPending: vi.fn(),
			getUserMessageText: vi.fn(() => "expanded skill body"),
			removeTrailingOptimisticUserPaint: vi.fn(),
		};
		const message = { role: "user", content: "expanded skill body" };

		interactiveModePrototype.reconcileOptimisticUserMessage.call(context, message);

		expect(context.removeTrailingOptimisticUserPaint).toHaveBeenCalledTimes(1);
		expect(context.addMessageToChat).toHaveBeenCalledWith(message);
		expect(context.optimisticUserMessageText).toBeUndefined();
	});
});
