import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";

describe("regression #3667: /reload repopulates editor prompt history", () => {
	test("rebuildChatFromMessages forwards populateHistory to renderSessionContext", () => {
		const sessionContext = { messages: [], entries: [] };
		const fakeThis = {
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildSessionContext: vi.fn().mockReturnValue(sessionContext) },
			renderSessionContext: vi.fn(),
		};

		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
			options?: { populateHistory?: boolean },
		) => void;

		rebuildChatFromMessages.call(fakeThis, { populateHistory: true });

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionContext).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionContext).toHaveBeenCalledWith(sessionContext, { populateHistory: true });
	});

	test("rebuildChatFromMessages defaults to not populating history for non-reload callers", () => {
		const sessionContext = { messages: [], entries: [] };
		const fakeThis = {
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildSessionContext: vi.fn().mockReturnValue(sessionContext) },
			renderSessionContext: vi.fn(),
		};

		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
			options?: { populateHistory?: boolean },
		) => void;

		rebuildChatFromMessages.call(fakeThis);

		expect(fakeThis.renderSessionContext).toHaveBeenCalledWith(sessionContext, {});
	});

	test("renderSessionContext calls editor.addToHistory for user messages when populateHistory is true", () => {
		const addToHistory = vi.fn();
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text", text: "first prompt" }],
		};
		const fakeThis = {
			pendingTools: { clear: vi.fn() },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			chatContainer: { addChild: vi.fn() },
			editor: { addToHistory },
			getUserMessageText: vi.fn().mockReturnValue("first prompt"),
			getMarkdownThemeWithSettings: vi.fn().mockReturnValue({}),
			addMessageToChat: vi.fn(function (
				this: typeof fakeThis,
				message: unknown,
				options?: { populateHistory?: boolean },
			) {
				// Reproduce the minimal branch we care about: user messages push to editor history
				// when populateHistory is set. This mirrors the real addMessageToChat logic.
				const msg = message as { role: string };
				if (msg.role === "user" && options?.populateHistory) {
					this.editor.addToHistory?.("first prompt");
				}
			}),
			ui: { requestRender: vi.fn() },
		};

		const renderSessionContext = Reflect.get(InteractiveMode.prototype, "renderSessionContext") as (
			this: typeof fakeThis,
			sessionContext: { messages: unknown[] },
			options?: { updateFooter?: boolean; populateHistory?: boolean },
		) => void;

		renderSessionContext.call(fakeThis, { messages: [userMessage] }, { populateHistory: true });

		expect(addToHistory).toHaveBeenCalledTimes(1);
		expect(addToHistory).toHaveBeenCalledWith("first prompt");
	});

	test("renderSessionContext does NOT call editor.addToHistory when populateHistory is false", () => {
		const addToHistory = vi.fn();
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text", text: "first prompt" }],
		};
		const fakeThis = {
			pendingTools: { clear: vi.fn() },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			chatContainer: { addChild: vi.fn() },
			editor: { addToHistory },
			getUserMessageText: vi.fn().mockReturnValue("first prompt"),
			getMarkdownThemeWithSettings: vi.fn().mockReturnValue({}),
			addMessageToChat: vi.fn(function (
				this: typeof fakeThis,
				message: unknown,
				options?: { populateHistory?: boolean },
			) {
				const msg = message as { role: string };
				if (msg.role === "user" && options?.populateHistory) {
					this.editor.addToHistory?.("first prompt");
				}
			}),
			ui: { requestRender: vi.fn() },
		};

		const renderSessionContext = Reflect.get(InteractiveMode.prototype, "renderSessionContext") as (
			this: typeof fakeThis,
			sessionContext: { messages: unknown[] },
			options?: { updateFooter?: boolean; populateHistory?: boolean },
		) => void;

		renderSessionContext.call(fakeThis, { messages: [userMessage] }, {});

		expect(addToHistory).not.toHaveBeenCalled();
	});
});
