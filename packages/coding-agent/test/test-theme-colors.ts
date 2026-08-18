import fs from "fs";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

// --- Color utilities ---

function hexToRgb(hex: string): [number, number, number] {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : [0, 0, 0];
}

function rgbToHex(r: number, g: number, b: number): string {
	return (
		"#" +
		[r, g, b]
			.map((x) =>
				Math.round(Math.max(0, Math.min(255, x)))
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")
	);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b),
		min = Math.min(r, g, b);
	let h = 0,
		s = 0;
	const l = (max + min) / 2;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r:
				h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
				break;
			case g:
				h = ((b - r) / d + 2) / 6;
				break;
			case b:
				h = ((r - g) / d + 4) / 6;
				break;
		}
	}
	return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	let r: number, g: number, b: number;
	if (s === 0) {
		r = g = b = l;
	} else {
		const hue2rgb = (p: number, q: number, t: number) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		};
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function getLuminance(r: number, g: number, b: number): number {
	const lin = (c: number) => {
		c = c / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function getContrast(rgb: [number, number, number], bgLum: number): number {
	const fgLum = getLuminance(...rgb);
	const lighter = Math.max(fgLum, bgLum);
	const darker = Math.min(fgLum, bgLum);
	return (lighter + 0.05) / (darker + 0.05);
}

function adjustColorToContrast(hex: string, targetContrast: number, againstWhite: boolean): string {
	const rgb = hexToRgb(hex);
	const [h, s] = rgbToHsl(...rgb);
	const bgLum = againstWhite ? 1.0 : 0.0;

	let lo = againstWhite ? 0 : 0.5;
	let hi = againstWhite ? 0.5 : 1.0;

	for (let i = 0; i < 50; i++) {
		const mid = (lo + hi) / 2;
		const testRgb = hslToRgb(h, s, mid);
		const contrast = getContrast(testRgb, bgLum);

		if (againstWhite) {
			if (contrast < targetContrast) hi = mid;
			else lo = mid;
		} else {
			if (contrast < targetContrast) lo = mid;
			else hi = mid;
		}
	}

	const finalL = againstWhite ? lo : hi;
	return rgbToHex(...hslToRgb(h, s, finalL));
}

function fgAnsi(hex: string): string {
	const rgb = hexToRgb(hex);
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

const reset = "\x1b[0m";

// --- Commands ---

function cmdContrast(targetContrast: number): void {
	const baseColors = {
		teal: "#5f8787",
		blue: "#5f87af",
		green: "#87af87",
		yellow: "#d7af5f",
		red: "#af5f5f",
	};

	console.log(`\n=== Colors adjusted to ${targetContrast}:1 contrast ===\n`);

	console.log("For LIGHT theme (vs white):");
	for (const [name, hex] of Object.entries(baseColors)) {
		const adjusted = adjustColorToContrast(hex, targetContrast, true);
		const rgb = hexToRgb(adjusted);
		const contrast = getContrast(rgb, 1.0);
		console.log(`  ${name.padEnd(8)} ${fgAnsi(adjusted)}Sample${reset}  ${adjusted}  (${contrast.toFixed(2)}:1)`);
	}

	console.log("\nFor DARK theme (vs black):");
	for (const [name, hex] of Object.entries(baseColors)) {
		const adjusted = adjustColorToContrast(hex, targetContrast, false);
		const rgb = hexToRgb(adjusted);
		const contrast = getContrast(rgb, 0.0);
		console.log(`  ${name.padEnd(8)} ${fgAnsi(adjusted)}Sample${reset}  ${adjusted}  (${contrast.toFixed(2)}:1)`);
	}
}

function cmdTest(filePath: string): void {
	if (!fs.existsSync(filePath)) {
		console.error(`File not found: ${filePath}`);
		process.exit(1);
	}

	const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	const vars = data.vars || data;

	console.log(`\n=== Testing ${filePath} ===\n`);

	for (const [name, hex] of Object.entries(vars as Record<string, string>)) {
		if (!hex.startsWith("#")) continue;
		const rgb = hexToRgb(hex);
		const vsWhite = getContrast(rgb, 1.0);
		const vsBlack = getContrast(rgb, 0.0);
		const passW = vsWhite >= 4.5 ? "AA" : vsWhite >= 3.0 ? "AA-lg" : "FAIL";
		const passB = vsBlack >= 4.5 ? "AA" : vsBlack >= 3.0 ? "AA-lg" : "FAIL";
		console.log(
			`${name.padEnd(14)} ${fgAnsi(hex)}Sample text${reset}  ${hex}  white: ${vsWhite.toFixed(2)}:1 ${passW.padEnd(5)}  black: ${vsBlack.toFixed(2)}:1 ${passB}`,
		);
	}
}

function cmdTheme(themeName: string): void {
	process.env.COLORTERM = "truecolor";
	initTheme(themeName);

	const parseAnsiRgb = (ansi: string): [number, number, number] | null => {
		const match = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
		return match ? [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)] : null;
	};

	const getContrastVsWhite = (colorName: string): string => {
		const ansi = theme.getFgAnsi(colorName as Parameters<typeof theme.getFgAnsi>[0]);
		const rgb = parseAnsiRgb(ansi);
		if (!rgb) return "(default)";
		const ratio = getContrast(rgb, 1.0);
		const pass = ratio >= 4.5 ? "AA" : ratio >= 3.0 ? "AA-lg" : "FAIL";
		return `${ratio.toFixed(2)}:1 ${pass}`;
	};

	const getContrastVsBlack = (colorName: string): string => {
		const ansi = theme.getFgAnsi(colorName as Parameters<typeof theme.getFgAnsi>[0]);
		const rgb = parseAnsiRgb(ansi);
		if (!rgb) return "(default)";
		const ratio = getContrast(rgb, 0.0);
		const pass = ratio >= 4.5 ? "AA" : ratio >= 3.0 ? "AA-lg" : "FAIL";
		return `${ratio.toFixed(2)}:1 ${pass}`;
	};

	const logColor = (name: string): void => {
		const sample = theme.fg(name as Parameters<typeof theme.fg>[0], "Sample text");
		const cw = getContrastVsWhite(name);
		const cb = getContrastVsBlack(name);
		console.log(`${name.padEnd(20)} ${sample}  white: ${cw.padEnd(12)} black: ${cb}`);
	};

	console.log(`\n=== ${themeName} theme (WCAG AA = 4.5:1) ===`);

	console.log("\n--- Core UI ---");
	["accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim"].forEach(logColor);

	console.log("\n--- Markdown ---");
	["mdHeading", "mdLink", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdListBullet"].forEach(logColor);

	console.log("\n--- Diff ---");
	["toolDiffAdded", "toolDiffRemoved", "toolDiffContext"].forEach(logColor);

	console.log("\n--- Thinking ---");
	["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh"].forEach(logColor);

	console.log("\n--- Backgrounds ---");
	console.log("userMessageBg:", theme.bg("userMessageBg", " Sample "));
	const searchMatch = theme.bg("searchMatchBg", theme.fg("searchMatchText", " Sample "));
	console.log("searchMatch:", theme.underline(searchMatch));
	console.log("searchCurrentMatch:", theme.bold(theme.inverse(searchMatch)));
	console.log("toolPendingBg:", theme.bg("toolPendingBg", " Sample "));
	console.log("toolSuccessBg:", theme.bg("toolSuccessBg", " Sample "));
	console.log("toolErrorBg:", theme.bg("toolErrorBg", " Sample "));
	console.log();
}

// --- Main ---

const [cmd, arg] = process.argv.slice(2);

if (cmd === "contrast") {
	cmdContrast(parseFloat(arg) || 4.5);
} else if (cmd === "test") {
	cmdTest(arg);
} else if (cmd === "light" || cmd === "dark") {
	cmdTheme(cmd);
} else {
	console.log("Usage:");
	console.log("  npx tsx test-theme-colors.ts light|dark     Test built-in theme");
	console.log("  npx tsx test-theme-colors.ts contrast 4.5   Compute colors at ratio");
	console.log("  npx tsx test-theme-colors.ts test file.json Test any JSON file");
}
