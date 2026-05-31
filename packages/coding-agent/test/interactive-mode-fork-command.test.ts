import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SelectorFocus = { onSelect?: (entryId: string) => void };
type SelectorFactoryResult = { component: unknown; focus: SelectorFocus };
type SelectorFactory = (done: () => void) => SelectorFactoryResult;

type ForkCommandContext = {
	sessionManager: { getSessionName: () => string | undefined };
	session: {
		setSessionName: (name: string) => void;
		getUserMessagesForForking: () => Array<{ entryId: string; text: string }>;
	};
	runtimeHost: {
		fork: (
			entryId: string,
			options?: { position?: "before" | "at" },
		) => Promise<{ cancelled: boolean; selectedText?: string }>;
	};
	renderCurrentSessionState: () => void;
	editor: { setText: (text: string) => void };
	chatContainer: { addChild: (child: unknown) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	showSelector: (create: SelectorFactory) => void;
	ui: { requestRender: () => void };
};

type ParserContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { setText: (text: string) => void };
	showUserMessageSelector: (name?: string) => void;
};

type InteractiveModePrototype = {
	setupEditorSubmitHandler(this: ParserContext): void;
	showUserMessageSelector(this: ForkCommandContext, name?: string): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type Renderable = { render: (width: number) => string[] };

function renderAddedChildren(addChild: ReturnType<typeof vi.fn>): string {
	return addChild.mock.calls.map(([child]) => (child as Renderable).render(80).join("\n")).join("\n");
}

describe("InteractiveMode /fork", () => {
	initTheme("dark");

	it("parses a submitted session name", async () => {
		const context: ParserContext = {
			defaultEditor: {},
			editor: { setText: vi.fn() },
			showUserMessageSelector: vi.fn(),
		};

		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("  /fork   Parser Named Session  ");

		expect(context.showUserMessageSelector).toHaveBeenCalledWith("Parser Named Session");
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("starts an unnamed fork", async () => {
		const fork = vi.fn(async () => ({ cancelled: false, selectedText: "hello" }));
		const requestRender = vi.fn();
		let capturedCreate: SelectorFactory | undefined;

		const context: ForkCommandContext = {
			sessionManager: { getSessionName: () => undefined },
			session: {
				setSessionName: vi.fn(),
				getUserMessagesForForking: () => [{ entryId: "msg-1", text: "Hello" }],
			},
			runtimeHost: { fork },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showSelector: (create) => {
				capturedCreate = create;
			},
			ui: { requestRender },
		};

		interactiveModePrototype.showUserMessageSelector.call(context);

		expect(capturedCreate).toBeDefined();
		const done = vi.fn();
		const { focus } = capturedCreate!(done);
		await focus.onSelect!("msg-1");

		expect(fork).toHaveBeenCalledWith("msg-1");
		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(context.renderCurrentSessionState).toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("hello");
		expect(context.chatContainer.addChild).toHaveBeenCalledTimes(2);
		expect(done).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("starts a named fork", async () => {
		const fork = vi.fn(async () => ({ cancelled: false, selectedText: "hello" }));
		let capturedCreate: SelectorFactory | undefined;
		let storedName: string | undefined;
		const setSessionName = vi.fn((name: string) => {
			storedName = name;
		});

		const context: ForkCommandContext = {
			sessionManager: { getSessionName: () => storedName },
			session: {
				setSessionName,
				getUserMessagesForForking: () => [{ entryId: "msg-1", text: "Hello" }],
			},
			runtimeHost: { fork },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showSelector: (create) => {
				capturedCreate = create;
			},
			ui: { requestRender: vi.fn() },
		};

		interactiveModePrototype.showUserMessageSelector.call(context, "Named Session");

		const done = vi.fn();
		const { focus } = capturedCreate!(done);
		await focus.onSelect!("msg-1");

		expect(setSessionName).toHaveBeenCalledWith("Named Session");
		const addChild = context.chatContainer.addChild as ReturnType<typeof vi.fn>;
		expect(renderAddedChildren(addChild)).toContain("Named Session");
		expect(done).toHaveBeenCalledTimes(1);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not set name when fork is cancelled", async () => {
		const fork = vi.fn(async () => ({ cancelled: true }));
		let capturedCreate: SelectorFactory | undefined;

		const context: ForkCommandContext = {
			sessionManager: { getSessionName: () => undefined },
			session: {
				setSessionName: vi.fn(),
				getUserMessagesForForking: () => [{ entryId: "msg-1", text: "Hello" }],
			},
			runtimeHost: { fork },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showSelector: (create) => {
				capturedCreate = create;
			},
			ui: { requestRender: vi.fn() },
		};

		interactiveModePrototype.showUserMessageSelector.call(context, "Should Not Stick");

		const done = vi.fn();
		const { focus } = capturedCreate!(done);
		await focus.onSelect!("msg-1");

		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(context.chatContainer.addChild).not.toHaveBeenCalled();
		expect(done).toHaveBeenCalledTimes(1);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("shows a status message when there are no messages to fork from", () => {
		const context: ForkCommandContext = {
			sessionManager: { getSessionName: () => undefined },
			session: {
				setSessionName: vi.fn(),
				getUserMessagesForForking: () => [],
			},
			runtimeHost: { fork: vi.fn() },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showSelector: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		interactiveModePrototype.showUserMessageSelector.call(context);

		expect(context.showStatus).toHaveBeenCalledWith("No messages to fork from");
		expect(context.showSelector).not.toHaveBeenCalled();
	});
});
