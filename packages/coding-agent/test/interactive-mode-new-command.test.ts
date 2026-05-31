import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type NewCommandContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	runtimeHost: {
		newSession: () => Promise<{ cancelled: boolean }>;
	};
	session: { setSessionName: (name: string) => void };
	sessionManager: { getSessionName: () => string | undefined };
	renderCurrentSessionState: () => void;
	chatContainer: { addChild: (child: unknown) => void };
	ui: { requestRender: () => void };
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
};

type ParserContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { setText: (text: string) => void };
	handleNewCommand: (name?: string) => Promise<void>;
};

type InteractiveModePrototype = {
	setupEditorSubmitHandler(this: ParserContext): void;
	handleNewCommand(this: NewCommandContext, name?: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type Renderable = { render: (width: number) => string[] };

function renderAddedChildren(addChild: ReturnType<typeof vi.fn>): string {
	return addChild.mock.calls.map(([child]) => (child as Renderable).render(80).join("\n")).join("\n");
}

function createContext(newSession: NewCommandContext["runtimeHost"]["newSession"]): NewCommandContext {
	return {
		statusContainer: { clear: vi.fn() },
		runtimeHost: { newSession },
		session: { setSessionName: vi.fn() },
		sessionManager: { getSessionName: vi.fn(() => undefined) },
		renderCurrentSessionState: vi.fn(),
		chatContainer: { addChild: vi.fn() },
		ui: { requestRender: vi.fn() },
		handleFatalRuntimeError: vi.fn(async (_prefix, error) => {
			throw error instanceof Error ? error : new Error(String(error));
		}),
	};
}

describe("InteractiveMode /new", () => {
	initTheme("dark");

	it("parses a submitted session name", async () => {
		const context: ParserContext = {
			defaultEditor: {},
			editor: { setText: vi.fn() },
			handleNewCommand: vi.fn(async () => undefined),
		};

		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("  /new   Parser Named Session  ");

		expect(context.handleNewCommand).toHaveBeenCalledWith("Parser Named Session");
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("starts an unnamed session", async () => {
		const newSession = vi.fn(async () => ({ cancelled: false }));
		const context = createContext(newSession);

		await interactiveModePrototype.handleNewCommand.call(context);

		expect(newSession).toHaveBeenCalledWith();
		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(context.renderCurrentSessionState).toHaveBeenCalled();
		expect(context.chatContainer.addChild).toHaveBeenCalledTimes(2);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("starts a named session", async () => {
		const newSession = vi.fn(async () => ({ cancelled: false }));
		const context = createContext(newSession);
		let storedName: string | undefined;
		const setSessionName = vi.fn((name: string) => {
			storedName = name;
		});

		context.session = { setSessionName };
		context.sessionManager.getSessionName = vi.fn(() => storedName);

		await interactiveModePrototype.handleNewCommand.call(context, "Named Session");

		expect(newSession).toHaveBeenCalledWith();
		expect(setSessionName).toHaveBeenCalledWith("Named Session");
		expect(context.renderCurrentSessionState).toHaveBeenCalled();
		const addChild = context.chatContainer.addChild as ReturnType<typeof vi.fn>;
		expect(renderAddedChildren(addChild)).toContain("Named Session");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not render when new session creation is cancelled", async () => {
		const newSession = vi.fn(async () => ({ cancelled: true }));
		const context = createContext(newSession);

		await interactiveModePrototype.handleNewCommand.call(context, "Named Session");

		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(context.chatContainer.addChild).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
	});
});
