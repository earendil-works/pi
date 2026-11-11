export type IconPreset = "unicode" | "nerd";
export type IconName =
	| "code"
	| "quote"
	| "copy"
	| "chat"
	| "agent"
	| "agentWorker"
	| "agentScout"
	| "agentReviewer"
	| "agentPlanner"
	| "statusDot";

const ICONS: Record<IconPreset, Record<IconName, string>> = {
	unicode: {
		code: "</>",
		quote: "❯",
		copy: "⧉",
		chat: "?",
		agent: "@",
		agentWorker: "</>",
		agentScout: "?",
		agentReviewer: "✓",
		agentPlanner: "≡",
		statusDot: "\u2022",
	},
	nerd: {
		code: "\uf44f",
		quote: "\uf10e",
		copy: "\u{f09a8}",
		chat: "\uf075",
		agent: "\uf007",
		agentWorker: "\uf0ad",
		agentScout: "\uf002",
		agentReviewer: "\uf132",
		agentPlanner: "\uf0ae",
		statusDot: "\u2022",
	},
};

// Extensions loaded through jiti must see the same preset as the main interactive runtime.
const ICON_PRESET_KEY = Symbol.for("@earendil-works/pi-coding-agent:icon-preset");

/** Return an uncolored icon using the interactive harness's current preset. */
export function icon(name: IconName): string {
	const preset = (globalThis as Record<symbol, IconPreset | undefined>)[ICON_PRESET_KEY] ?? "unicode";
	return ICONS[preset][name];
}

/** Apply the configured icon preset to all interactive components and extension module loaders. */
export function setIconPreset(preset: IconPreset): void {
	(globalThis as Record<symbol, IconPreset>)[ICON_PRESET_KEY] = preset;
}
