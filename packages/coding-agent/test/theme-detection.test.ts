import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	detectTerminalBackground,
	getThemeByName,
	getThemeForRgbColor,
	parseOsc11BackgroundColor,
	queryTerminalBackgroundColor,
	type TerminalBackgroundQueryInput,
	type TerminalBackgroundQueryOutput,
} from "../src/modes/interactive/theme/theme.ts";

class FakeStdin implements TerminalBackgroundQueryInput {
	isTTY = true;
	isRaw = false;
	private paused = true;
	private readonly listeners = new Set<(data: string | Buffer) => void>();

	setRawMode(mode: boolean): void {
		this.isRaw = mode;
	}

	setEncoding(_encoding: BufferEncoding): void {}

	resume(): void {
		this.paused = false;
	}

	pause(): void {
		this.paused = true;
	}

	isPaused(): boolean {
		return this.paused;
	}

	on(_event: "data", listener: (data: string | Buffer) => void): void {
		this.listeners.add(listener);
	}

	off(_event: "data", listener: (data: string | Buffer) => void): void {
		this.listeners.delete(listener);
	}

	send(data: string): void {
		for (const listener of this.listeners) {
			listener(data);
		}
	}
}

class FakeStdout implements TerminalBackgroundQueryOutput {
	isTTY = true;
	writes: string[] = [];
	private readonly onWriteCallback: (() => void) | undefined;

	constructor(onWrite?: () => void) {
		this.onWriteCallback = onWrite;
	}

	write(data: string): boolean {
		this.writes.push(data);
		this.onWriteCallback?.();
		return true;
	}
}

afterEach(() => {
	resetCapabilitiesCache();
});

describe("detectTerminalBackground", () => {
	it("uses the terminal background color before COLORFGBG", () => {
		expect(
			detectTerminalBackground({ env: { COLORFGBG: "15;0" }, terminalBackgroundColor: { r: 255, g: 255, b: 255 } }),
		).toMatchObject({
			theme: "light",
			source: "terminal background",
			confidence: "high",
		});
	});

	it("uses the COLORFGBG background color index", () => {
		expect(detectTerminalBackground({ env: { COLORFGBG: "0;15" } })).toMatchObject({
			theme: "light",
			source: "COLORFGBG",
			confidence: "high",
		});
		expect(detectTerminalBackground({ env: { COLORFGBG: "15;0" } })).toMatchObject({
			theme: "dark",
			source: "COLORFGBG",
			confidence: "high",
		});
	});

	it("uses the last COLORFGBG field as the background", () => {
		expect(detectTerminalBackground({ env: { COLORFGBG: "0;7;15" } }).theme).toBe("light");
	});

	it("defaults to dark without terminal background hints", () => {
		expect(detectTerminalBackground({ env: {} })).toMatchObject({
			theme: "dark",
			source: "fallback",
			confidence: "low",
		});
	});
});

describe("theme color mode", () => {
	it("uses terminal capabilities", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const ansi256Theme = getThemeByName("dark");
		if (!ansi256Theme) throw new Error("dark theme not found");
		expect(ansi256Theme.getColorMode()).toBe("256color");
		expect(ansi256Theme.getFgAnsi("accent")).toMatch(/^\x1b\[38;5;\d+m$/);

		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const truecolorTheme = getThemeByName("dark");
		if (!truecolorTheme) throw new Error("dark theme not found");
		expect(truecolorTheme.getColorMode()).toBe("truecolor");
		expect(truecolorTheme.getFgAnsi("accent")).toMatch(/^\x1b\[38;2;\d+;\d+;\d+m$/);
	});
});

describe("queryTerminalBackgroundColor", () => {
	it("queries OSC 11 and restores stdin state", async () => {
		const stdin = new FakeStdin();
		const stdout = new FakeStdout(() => {
			queueMicrotask(() => stdin.send("\x1b]11;rgb:ffff/ffff/ffff\x07"));
		});

		await expect(queryTerminalBackgroundColor({ stdin, stdout, timeoutMs: 50 })).resolves.toEqual({
			r: 255,
			g: 255,
			b: 255,
		});
		expect(stdout.writes).toEqual(["\x1b]11;?\x07"]);
		expect(stdin.isRaw).toBe(false);
		expect(stdin.isPaused()).toBe(true);
	});
});

describe("parseOsc11BackgroundColor", () => {
	it("parses 16-bit OSC 11 rgb responses", () => {
		expect(parseOsc11BackgroundColor("\x1b]11;rgb:0000/8000/ffff\x07")).toEqual({ r: 0, g: 128, b: 255 });
	});

	it("parses OSC 11 hex responses", () => {
		expect(parseOsc11BackgroundColor("\x1b]11;#ffffff\x1b\\")).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseOsc11BackgroundColor("\x1b]11;#000000\x07")).toEqual({ r: 0, g: 0, b: 0 });
	});

	it("classifies RGB colors by luminance", () => {
		expect(getThemeForRgbColor({ r: 8, g: 8, b: 8 })).toBe("dark");
		expect(getThemeForRgbColor({ r: 250, g: 250, b: 250 })).toBe("light");
	});
});
