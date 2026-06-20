import type { TUI } from "../tui.ts";
import { Spinner, type SpinnerOptions } from "./spinner.ts";
import { Text } from "./text.ts";

export type LoaderIndicatorOptions = SpinnerOptions;

/**
 * Loader component that updates with an optional spinning animation.
 */
export class Loader extends Text {
	private ui: TUI;
	private spinner: Spinner;
	private spinnerColorFn: (str: string) => string;
	private messageColorFn: (str: string) => string;
	private message: string = "Loading...";
	private shouldColorSpinner = true;

	constructor(
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.shouldColorSpinner = indicator?.frames === undefined;
		this.spinner = new Spinner(() => this.updateDisplay(), indicator);
		this.spinner.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.spinner.start();
	}

	stop(): void {
		this.spinner.stop();
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.shouldColorSpinner = indicator?.frames === undefined;
		this.spinner.setOptions(indicator);
	}

	private updateDisplay(): void {
		const frame = this.spinner.renderText();
		const renderedFrame = frame && this.shouldColorSpinner ? this.spinnerColorFn(frame) : frame;
		const indicator = renderedFrame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		this.ui.requestRender();
	}
}
