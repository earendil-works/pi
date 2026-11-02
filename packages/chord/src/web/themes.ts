/// <reference lib="dom" />
// The page's themes (slice 11 §4b, decision "Looks and themes"): the active theme written as CSS custom properties on
// `:root` (and `color-scheme`), following the registry, the user's pick and the system's colour scheme; no reload. The
// app's stylesheet and the plugins' CSS read the variables.

import type { Context } from "../context/index.ts";
import type { Principal } from "../data/index.ts";
import type { Host } from "../host/index.ts";
import { followActiveTheme, themeVariables } from "../surfaces/index.ts";

/** Follows the themes on `host` and writes the active one on `:root` until the returned stop. */
export async function followThemes<P extends Principal>(host: Host<P>, context: Context): Promise<() => void> {
	const scheme = matchMedia("(prefers-color-scheme: dark)");
	let written: readonly string[] = [];
	const follower = await followActiveTheme(
		host,
		scheme.matches ? "dark" : "light",
		(theme) => {
			written = writeVariables(themeVariables(theme), written);
			document.documentElement.style.colorScheme = theme.mode;
		},
		context,
	);
	const schemeChanged = (): void => follower.setMode(scheme.matches ? "dark" : "light");
	scheme.addEventListener("change", schemeChanged);
	return () => {
		follower.stop();
		scheme.removeEventListener("change", schemeChanged);
	};
}

/** Sets `variables` on `:root`, removing those of `before` it no longer has; the names it set. */
function writeVariables(variables: Readonly<Record<string, string>>, before: readonly string[]): readonly string[] {
	const style = document.documentElement.style;
	for (const name of before) if (!Object.hasOwn(variables, name)) style.removeProperty(name);
	for (const [name, value] of Object.entries(variables)) style.setProperty(name, value);
	return Object.keys(variables);
}
