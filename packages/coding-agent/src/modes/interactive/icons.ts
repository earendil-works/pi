export type IconPreset = "unicode" | "nerd";
export type IconName = "code" | "quote" | "copy";

const ICONS: Record<IconPreset, Record<IconName, string>> = {
	unicode: { code: "</>", quote: "❯", copy: "⧉" },
	nerd: { code: "\uf44f", quote: "\uf10e", copy: "\u{f09a8}" },
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
