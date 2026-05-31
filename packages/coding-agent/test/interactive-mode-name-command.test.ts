import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type NameCommandContext = {
	session: { setSessionName: (name: string) => void };
	sessionManager: { getSessionName: () => string | undefined };
	chatContainer: { addChild: (child: unknown) => void };
	showWarning: (message: string) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleNameCommand(this: NameCommandContext, text: string): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type Renderable = { render: (width: number) => string[] };

function renderAddedChildren(addChild: ReturnType<typeof vi.fn>): string {
	return addChild.mock.calls.map(([child]) => (child as Renderable).render(80).join("\n")).join("\n");
}

function createContext(sessionName: string | undefined): NameCommandContext {
	return {
		session: { setSessionName: vi.fn() },
		sessionManager: { getSessionName: vi.fn(() => sessionName) },
		chatContainer: { addChild: vi.fn() },
		showWarning: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
}

describe("InteractiveMode /name", () => {
	initTheme("dark");

	it("displays the stored session name instead of the raw input", () => {
		const context = createContext("Stored Session Name");

		interactiveModePrototype.handleNameCommand.call(context, "/name Raw Session Name");

		expect(context.session.setSessionName).toHaveBeenCalledWith("Raw Session Name");
		const addChild = context.chatContainer.addChild as ReturnType<typeof vi.fn>;
		const output = renderAddedChildren(addChild);
		expect(output).toContain("Stored Session Name");
		expect(output).not.toContain("Raw Session Name");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("shows the current session name when no name argument is given", () => {
		const context = createContext("Existing Name");

		interactiveModePrototype.handleNameCommand.call(context, "/name");

		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(context.showWarning).not.toHaveBeenCalled();
		const output = renderAddedChildren(context.chatContainer.addChild as ReturnType<typeof vi.fn>);
		expect(output).toContain("Existing Name");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("shows a usage warning when no name argument is given and session has no name", () => {
		const context = createContext(undefined);

		interactiveModePrototype.handleNameCommand.call(context, "/name");

		expect(context.session.setSessionName).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith("Usage: /name <name>");
		expect(context.chatContainer.addChild).not.toHaveBeenCalled();
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
