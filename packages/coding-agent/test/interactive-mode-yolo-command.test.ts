import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type YoloCommandContext = {
	session: {
		setYoloMode: (enabled: boolean) => void;
		toggleYoloMode: () => boolean;
	};
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
};

type InteractiveModePrototype = {
	handleYoloCommand(this: YoloCommandContext, text: string): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /yolo", () => {
	it("toggles yolo mode when no argument is provided", () => {
		const showStatus = vi.fn();
		const context: YoloCommandContext = {
			session: {
				setYoloMode: vi.fn(),
				toggleYoloMode: vi.fn(() => true),
			},
			showStatus,
			showWarning: vi.fn(),
		};

		interactiveModePrototype.handleYoloCommand.call(context, "/yolo");

		expect(context.session.toggleYoloMode).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("YOLO mode enabled: tool permission prompts disabled");
	});

	it("supports explicit off", () => {
		const setYoloMode = vi.fn();
		const showStatus = vi.fn();
		const context: YoloCommandContext = {
			session: {
				setYoloMode,
				toggleYoloMode: vi.fn(),
			},
			showStatus,
			showWarning: vi.fn(),
		};

		interactiveModePrototype.handleYoloCommand.call(context, "/yolo off");

		expect(setYoloMode).toHaveBeenCalledWith(false);
		expect(context.session.toggleYoloMode).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("YOLO mode disabled");
	});

	it("warns on invalid arguments", () => {
		const showWarning = vi.fn();
		const context: YoloCommandContext = {
			session: {
				setYoloMode: vi.fn(),
				toggleYoloMode: vi.fn(),
			},
			showStatus: vi.fn(),
			showWarning,
		};

		interactiveModePrototype.handleYoloCommand.call(context, "/yolo maybe");

		expect(showWarning).toHaveBeenCalledWith("Usage: /yolo [on|off]");
		expect(context.session.setYoloMode).not.toHaveBeenCalled();
		expect(context.session.toggleYoloMode).not.toHaveBeenCalled();
	});
});
