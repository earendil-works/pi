// Looks and themes (slice 11 §4b, decision "Looks and themes", `docs/theming/`): a theme is data in one registry,
// `Themes`, that plugins contribute to on any host kind; a page writes the active theme as CSS custom properties on
// `:root`, a terminal looks colours up by role. A theme names a colour for each role (the kit's base roles, and roles
// an app adds), with `web` extras (more CSS variables: radii, fonts) and `tui` overrides (a colour per role for
// terminals). The user picks one dark and one light theme (`ThemeChoice`); the system's mode chooses between them.

import type { Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import { defineRegistry, type Registry } from "../registries/index.ts";

/** The roles every theme names: the kit's base set. Apps add their own roles; themes fill at least these. */
export const BASE_ROLES = ["accent", "bg", "fg", "muted", "error", "warning", "success"] as const;

/** A base role. */
export type BaseRole = (typeof BASE_ROLES)[number];

/** A theme: an id, a name, its mode, a colour per role (CSS colours; `#rrggbb` for terminals), web and terminal extras. */
export type Theme = {
	readonly id: string;
	readonly name: string;
	readonly mode: "dark" | "light";
	readonly colors: Readonly<Record<BaseRole, string>> & Readonly<Record<string, string>>;
	/** More CSS variables on `:root`, by name without `--` (`radius`, `font`); URLs of the plugin's assets allowed. */
	readonly web?: Readonly<Record<string, string>>;
	/** Terminal colours by role, before `colors`: `#rrggbb` or an xterm 256-colour index (`"208"`). */
	readonly tui?: Readonly<Record<string, string>>;
};

/** The themes plugins contribute, in plugin-name order; served on every client and on the server by the kit. */
export const Themes: Registry<Theme, readonly Theme[]> = defineRegistry<Theme, readonly Theme[]>("chord.themes", {
	version: 1,
});

/** The kit's facet serving `Themes` on a host: the contributions as they are, in plugin-name order. */
export function themesFacet<P extends Principal>(): Facet<P> {
	return defineFacet<P>((host) => host.serve(Themes, { compose: (table) => table.map(({ value }) => value) }));
}

/** The theme used when no plugin contributed one of a mode: neutral colours. */
export const FALLBACK_THEMES: Readonly<Record<Theme["mode"], Theme>> = {
	dark: {
		id: "chord.dark",
		name: "Dark",
		mode: "dark",
		colors: {
			accent: "#4c9aff",
			bg: "#16181d",
			fg: "#e6e6e6",
			muted: "#8a8f98",
			error: "#ff6b6b",
			warning: "#f0b429",
			success: "#3ecf8e",
		},
	},
	light: {
		id: "chord.light",
		name: "Light",
		mode: "light",
		colors: {
			accent: "#0b62d6",
			bg: "#ffffff",
			fg: "#1c1e21",
			muted: "#6b7280",
			error: "#c62828",
			warning: "#b26a00",
			success: "#1b7f4b",
		},
	},
};

/** The user's choice: a theme id for dark and one for light (`null`: the first contributed of that mode). */
export type ThemePick = { readonly dark: string | null; readonly light: string | null };

/** The active theme for `mode`: the one `pick` names if contributed, else the first of that mode, else the fallback. */
export function activeTheme(themes: readonly Theme[], pick: ThemePick, mode: Theme["mode"]): Theme {
	const wanted = pick[mode];
	const ofMode = themes.filter((theme) => theme.mode === mode);
	return ofMode.find((theme) => theme.id === wanted) ?? ofMode[0] ?? FALLBACK_THEMES[mode];
}

/** The CSS custom properties of `theme`: `--<role>` for every colour, then `--<name>` for each `web` extra. */
export function themeVariables(theme: Theme): Readonly<Record<string, string>> {
	const variables: Record<string, string> = {};
	for (const [role, color] of Object.entries(theme.colors)) variables[`--${role}`] = color;
	for (const [name, value] of Object.entries(theme.web ?? {})) variables[`--${name}`] = value;
	return variables;
}

/** How many colours a terminal shows. */
export type ColorDepth = "truecolor" | "256";

/**
 * The SGR parameters of `role`'s colour in `theme` for a terminal of `depth` (`38;2;r;g;b`, `38;5;n`; `48;…` for a
 * background): the role's `tui` override first, else its colour, else the fallback theme's; a `#rrggbb` colour is the
 * nearest of the 256 xterm colours on a 256-colour terminal. A role nobody defines, or a colour that is no `#rrggbb`,
 * gives the terminal's default (`39`, `49`).
 */
export function terminalColor(theme: Theme, role: string, depth: ColorDepth, layer: "fg" | "bg"): string {
	const fallback = FALLBACK_THEMES[theme.mode].colors as Readonly<Record<string, string>>;
	const color = theme.tui?.[role] ?? theme.colors[role] ?? fallback[role];
	const base = layer === "fg" ? "38" : "48";
	if (color !== undefined && /^\d{1,3}$/.test(color) && Number(color) < 256) return `${base};5;${color}`;
	const rgb = color === undefined ? undefined : parseHex(color);
	if (rgb === undefined) return layer === "fg" ? "39" : "49";
	if (depth === "truecolor") return `${base};2;${rgb.join(";")}`;
	return `${base};5;${nearest256(rgb)}`;
}

/** The red, green and blue of a `#rrggbb` colour. */
function parseHex(color: string): readonly [number, number, number] | undefined {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	if (match === null) return undefined;
	return [Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16), Number.parseInt(match[3]!, 16)];
}

/** The levels of the xterm 6×6×6 colour cube. */
const CUBE = [0, 95, 135, 175, 215, 255];

/** The nearest xterm 256-colour index to `rgb`: the nearer of the colour cube's (16–231) and the grey ramp's (232–255). */
function nearest256(rgb: readonly [number, number, number]): number {
	const level = (value: number): number => {
		let best = 0;
		for (let index = 1; index < CUBE.length; index++) {
			if (Math.abs(CUBE[index]! - value) < Math.abs(CUBE[best]! - value)) best = index;
		}
		return best;
	};
	const [r, g, b] = rgb.map(level) as [number, number, number];
	const cube = [CUBE[r]!, CUBE[g]!, CUBE[b]!] as const;
	const average = (rgb[0] + rgb[1] + rgb[2]) / 3;
	const grey = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
	const greyValue = 8 + grey * 10;
	const distance = (other: readonly number[]): number =>
		(other[0]! - rgb[0]) ** 2 + (other[1]! - rgb[1]) ** 2 + (other[2]! - rgb[2]) ** 2;
	return distance([greyValue, greyValue, greyValue]) < distance(cube) ? 232 + grey : 16 + 36 * r + 6 * g + b;
}
