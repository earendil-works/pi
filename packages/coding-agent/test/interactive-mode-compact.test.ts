import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const model: Model<"anthropic-messages"> = {
	id: "summary-model",
	name: "Summary Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

type CompactContext = {
	clearStatusIndicator: () => void;
	settingsManager: { getCompactionSkipPrompt: () => boolean };
	session: {
		compact: ReturnType<typeof vi.fn>;
		resolveSummarizationConfig: (settingsKey: "compaction") => {
			model: Model<string>;
			thinkingLevel: ThinkingLevel;
		};
	};
	showCompactionPrompt: ReturnType<typeof vi.fn>;
	showSummarizationModelSelector: ReturnType<typeof vi.fn>;
	cycleSummarizationModel: ReturnType<typeof vi.fn>;
	showExtensionEditor: ReturnType<typeof vi.fn>;
};

type InteractiveModePrivate = {
	handleCompactCommand(this: CompactContext, customInstructions?: string): Promise<void>;
};

const handleCompactCommand = (InteractiveMode.prototype as unknown as InteractiveModePrivate).handleCompactCommand;

function createContext(skipPrompt: boolean): CompactContext {
	return {
		clearStatusIndicator: vi.fn(),
		settingsManager: { getCompactionSkipPrompt: () => skipPrompt },
		session: {
			compact: vi.fn(async () => {}),
			resolveSummarizationConfig: vi.fn((): { model: Model<string>; thinkingLevel: ThinkingLevel } => ({
				model,
				thinkingLevel: "high",
			})),
		},
		showCompactionPrompt: vi.fn(),
		showSummarizationModelSelector: vi.fn(),
		cycleSummarizationModel: vi.fn(),
		showExtensionEditor: vi.fn(),
	};
}

describe("InteractiveMode /compact", () => {
	it("preserves immediate bare compaction when skipPrompt is true", async () => {
		const context = createContext(true);

		await handleCompactCommand.call(context);

		expect(context.showCompactionPrompt).not.toHaveBeenCalled();
		expect(context.session.compact).toHaveBeenCalledWith(undefined);
	});

	it("opens the prompt for bare compaction when skipPrompt is false", async () => {
		const context = createContext(false);
		context.showCompactionPrompt.mockResolvedValue({ type: "choice", choice: "Compact" });

		await handleCompactCommand.call(context);

		expect(context.showCompactionPrompt).toHaveBeenCalledWith(model, "high", expect.any(Function));
		expect(context.session.compact).toHaveBeenCalledWith(undefined, {
			model,
			thinkingLevel: "high",
		});
	});

	it("keeps explicit instructions on the immediate path", async () => {
		const context = createContext(false);

		await handleCompactCommand.call(context, "focus on tests");

		expect(context.showCompactionPrompt).not.toHaveBeenCalled();
		expect(context.session.compact).toHaveBeenCalledWith("focus on tests");
	});

	it("uses custom instructions entered from the prompt", async () => {
		const context = createContext(false);
		context.showCompactionPrompt.mockResolvedValue({ type: "choice", choice: "Compact with custom prompt" });
		context.showExtensionEditor.mockResolvedValue("focus on decisions");

		await handleCompactCommand.call(context);

		expect(context.showExtensionEditor).toHaveBeenCalledWith("Custom compaction instructions");
		expect(context.session.compact).toHaveBeenCalledWith("focus on decisions", {
			model,
			thinkingLevel: "high",
		});
	});

	it("does not compact when the prompt is cancelled", async () => {
		const context = createContext(false);
		context.showCompactionPrompt.mockResolvedValue({ type: "choice", choice: "Cancel" });

		await handleCompactCommand.call(context);

		expect(context.session.compact).not.toHaveBeenCalled();
	});
});
