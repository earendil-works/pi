import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type UserInput = { text: string; images: ImageContent[] };

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	runtimeHost: {
		session: {
			isCompacting: boolean;
			isStreaming: boolean;
			isBashRunning: boolean;
			prompt: (text: string, options?: unknown) => Promise<void>;
		};
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (input: UserInput) => void;
	pendingImageAttachments: Map<number, { path: string; hash: string }>;
	pendingUserInputs: UserInput[];
};

type InputContext = {
	onInputCallback?: (input: UserInput) => void;
	pendingUserInputs: UserInput[];
};

type StartupSubmitContext = {
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
};

type InteractiveModePrivate = {
	handleStartupSubmit(this: StartupSubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<UserInput>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		runtimeHost: {
			session: {
				isCompacting: false,
				isStreaming: false,
				isBashRunning: false,
				prompt: vi.fn(async () => {}),
			},
		},
		flushPendingBashComponents: vi.fn(),
		pendingImageAttachments: new Map(),
		pendingUserInputs: [],
	}) as SubmitContext;
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

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt", images: [] }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const input = { text: "queued prompt", images: [] };
		const context: InputContext = {
			pendingUserInputs: [input],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe(input);
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});
