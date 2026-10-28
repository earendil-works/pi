import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ModelScopeContext = {
	session: { scopedModels: Array<{ model: { id: string }; thinkingLevel?: string }> };
	keybindings: { getKeys: (keybinding: string) => string[] };
	headerContainer: Container;
	shouldShowStartupDetails: () => boolean;
	getModelScopeNotice: () => string | undefined;
};

type InteractiveModePrivate = {
	getModelScopeNotice(this: ModelScopeContext): string | undefined;
	showFullscreenModelScopeNotice(this: ModelScopeContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createContext(showDetails = true): ModelScopeContext {
	return {
		session: { scopedModels: [{ model: { id: "model-a" }, thinkingLevel: "high" }, { model: { id: "model-b" } }] },
		keybindings: { getKeys: () => ["ctrl+p"] },
		headerContainer: new Container(),
		shouldShowStartupDetails: () => showDetails,
		getModelScopeNotice: interactiveModePrototype.getModelScopeNotice,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("InteractiveMode model scope notice", () => {
	beforeEach(() => initTheme("dark"));

	// Regression test for #11508: fullscreen must not print the notice to the shell's main screen.
	it("renders the model scope inside the fullscreen header instead of printing it", () => {
		const context = createContext();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			interactiveModePrototype.showFullscreenModelScopeNotice.call(context);
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}

		const rendered = stripAnsi(context.headerContainer.render(120).join("\n"));
		expect(rendered).toContain("Model scope: model-a:high, model-b (Ctrl+P to cycle)");
	});

	it("adds nothing when startup details are hidden", () => {
		const context = createContext(false);
		interactiveModePrototype.showFullscreenModelScopeNotice.call(context);
		expect(context.headerContainer.children).toHaveLength(0);
	});
});
