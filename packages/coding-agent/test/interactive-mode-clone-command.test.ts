import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type CloneCommandContext = {
	sessionManager: { getLeafId: () => string | null; getSessionName: () => string | undefined };
	runtimeHost: {
		fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean }>;
	};
	session: { setSessionName: (name: string) => void };
	renderCurrentSessionState: () => void;
	editor: { setText: (text: string) => void };
	chatContainer: { addChild: (child: unknown) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type ParserContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { setText: (text: string) => void };
	handleCloneCommand: (name?: string) => Promise<void>;
};

type InteractiveModePrototype = {
	setupEditorSubmitHandler(this: ParserContext): void;
	handleCloneCommand(this: CloneCommandContext, name?: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type Renderable = { render: (width: number) => string[] };

function renderAddedChildren(addChild: ReturnType<typeof vi.fn>): string {
	return addChild.mock.calls.map(([child]) => (child as Renderable).render(80).join("\n")).join("\n");
}

describe("InteractiveMode /clone", () => {
	initTheme("dark");

	it("parses a submitted session name", async () => {
		const context: ParserContext = {
			defaultEditor: {},
			editor: { setText: vi.fn() },
			handleCloneCommand: vi.fn(async () => undefined),
		};

		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("  /clone   Parser Named Session  ");

		expect(context.handleCloneCommand).toHaveBeenCalledWith("Parser Named Session");
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("clones the current leaf into a new session", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const renderCurrentSessionState = vi.fn();
		const setText = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();
		const addChild = vi.fn();

		const context: CloneCommandContext = {
			sessionManager: { getLeafId: () => "leaf-123", getSessionName: () => undefined },
			runtimeHost: { fork },
			session: { setSessionName: vi.fn() },
			renderCurrentSessionState,
			editor: { setText },
			chatContainer: { addChild },
			showStatus: vi.fn(),
			showError,
			ui: { requestRender },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).toHaveBeenCalledWith("leaf-123", { position: "at" });
		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(renderCurrentSessionState).toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(addChild).toHaveBeenCalledTimes(2);
		expect(renderAddedChildren(addChild)).toContain("Cloned to new session");
	});

	it("starts a named clone", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		let storedName: string | undefined;
		const setSessionName = vi.fn((name: string) => {
			storedName = name;
		});
		const context: CloneCommandContext = {
			sessionManager: { getLeafId: () => "leaf-123", getSessionName: () => storedName },
			runtimeHost: { fork },
			session: { setSessionName },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context, "Named Session");

		expect(fork).toHaveBeenCalledWith("leaf-123", { position: "at" });
		expect(setSessionName).toHaveBeenCalledWith("Named Session");
		expect(context.renderCurrentSessionState).toHaveBeenCalled();
		const addChild = context.chatContainer.addChild as ReturnType<typeof vi.fn>;
		expect(renderAddedChildren(addChild)).toContain("Named Session");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not render when clone is cancelled", async () => {
		const fork = vi.fn(async () => ({ cancelled: true }));
		const context: CloneCommandContext = {
			sessionManager: { getLeafId: () => "leaf-123", getSessionName: () => undefined },
			runtimeHost: { fork },
			session: { setSessionName: vi.fn() },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context, "Named Session");

		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(context.chatContainer.addChild).not.toHaveBeenCalled();
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("shows a status message when there is nothing to clone", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: CloneCommandContext = {
			sessionManager: { getLeafId: () => null, getSessionName: () => undefined },
			runtimeHost: { fork },
			session: { setSessionName: vi.fn() },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus,
			showError,
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not set name when there is nothing to clone", async () => {
		const showStatus = vi.fn();
		const context: CloneCommandContext = {
			sessionManager: { getLeafId: () => null, getSessionName: () => undefined },
			runtimeHost: { fork: vi.fn() },
			session: { setSessionName: vi.fn() },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			showStatus,
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context, "Should Not Stick");

		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
	});
});
