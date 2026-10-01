/**
 * pipi welcome banner — pi-plus branding on the CC-style banner shapes from
 * better-claude-code-ui (reference: ../my-pi-extensions/better-claude-code-ui/extension/banner.ts),
 * with a Pi+ block-character mark instead of the geometric pi logo: the
 * letters P and I drawn in blocks, a small + at the mark's upper right.
 *
 * Three width tiers plus a narrow-terminal fallback:
 * - Wide (full banner, >=76 cols): two-column box, `pi+ agent vX` wordmark in
 *   the top border, `Welcome back!` + Pi+ mark + model/cwd on the left,
 *   Extensions/Skills feeds on the right of a vertical divider.
 * - Boxed (full banner, 40..75 cols): a single rounded box hugging its
 *   content — Pi+ mark left, identity stack right — with the Extensions/Skills
 *   feeds as a borderless trailer under the box.
 * - Condensed (narrow terminals where the box can't fit): borderless stack,
 *   Pi+ mark left of a 3-line info column (`pi+ agent vX` / model / cwd),
 *   plus the resumed line when resuming.
 * - Compact (<40 cols): centered single-column box; below 15 cols the titled
 *   border can't fit, so degrade to a borderless centered stack.
 *
 * Registered as a hidden inline extension from the plus main wrapper
 * (MainOptions.extensionFactories); setHeader replaces pi's built-in startup
 * header, so no settings changes are needed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getAgentDir, VERSION } from "../../../../coding-agent/src/config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "../../../../coding-agent/src/core/extensions/types.ts";
import type { Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";

const SKILLS_MAX_ROWS = 6;
/** Below this render width the banner degrades to the centered compact box. */
const MIN_BOXED_WIDTH = 40;
/** From this width up the full banner renders as the two-column wide box. */
const FULL_MIN_WIDTH = 76;
const MAX_LEFT_WIDTH = 50;
const MIN_LEFT_WIDTH = 20;
const RIGHT_MIN_WIDTH = 20;

// Pi+ brand mark — the letters P and I drawn in block characters, with a
// small + (3x3) at the mark's upper right, 6-row grid. Every row is
// pre-padded to the mark width so per-row centering can't skew the glyph.
const PI_PLUS_LOGO: readonly string[] = [
	"██████  █████   █ ",
	"██   █    █    ███",
	"██   █    █     █ ",
	"█████     █       ",
	"██        █       ",
	"██      █████     ",
];

const APP_LABEL = "pi+ agent";

/**
 * pi-plus's own release train: the nearest package.json up from this module
 * is packages/plus-cli/package.json (in the staged bundle it's the bundle root's).
 * pipi --version and the version check follow pi's train, but the banner
 * brands pi+, so it shows the plus version. Any fs/format failure falls back
 * to pi's VERSION.
 */
function resolvePlusVersion(): string {
	try {
		let dir = dirname(fileURLToPath(import.meta.url));
		while (dir !== dirname(dir)) {
			const candidate = join(dir, "package.json");
			if (existsSync(candidate)) {
				const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
				if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
			}
			dir = dirname(dir);
		}
	} catch {
		// fall through to pi's version
	}
	return VERSION;
}

export const PLUS_VERSION = resolvePlusVersion();

/** Shorten $HOME to `~`; guards the HOME-unset / non-prefix cases. */
function tildeHome(p: string): string {
	const home = homedir();
	if (home && (p === home || p.startsWith(home + "/"))) return `~${p.slice(home.length)}`;
	return p;
}

export interface BannerInfo {
	model: () => string | undefined;
	cwd: string;
	resumed: string | undefined;
	title: () => string | undefined;
	welcome?: string;
	skills?: readonly string[];
	extensions?: readonly string[];
	/** Whether to show the boxed banner (always on; condensed is the narrow-terminal fallback). */
	full?: boolean;
}

function center(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "");
	const left = Math.floor((width - w) / 2);
	return " ".repeat(left) + text + " ".repeat(width - w - left);
}

function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - w);
}

/** Middle-truncate a path: keep first/…/last so the useful tail survives.
 *  A trailing slash is dropped so `last` stays the real tail segment. */
export function truncatePath(path: string, maxLen: number): string {
	if (visibleWidth(path) <= maxLen) return path;
	const sep = "/";
	const ellipsis = "…";
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	const parts = trimmed.split(sep);
	if (parts.length <= 1) return truncateToWidth(trimmed, maxLen, ellipsis);
	const first = parts[0]; // "" when the path is absolute (leading slash)
	const last = parts[parts.length - 1] || "";
	const candidate = `${first}${sep}${ellipsis}${sep}${last}`;
	if (visibleWidth(candidate) <= maxLen) return candidate;
	const head = `${first}${sep}${ellipsis}${sep}`;
	const lastMax = maxLen - visibleWidth(head);
	if (lastMax > 0) return `${head}${truncateToWidth(last, lastMax, ellipsis)}`;
	return truncateToWidth(trimmed, maxLen, ellipsis);
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Discover skill names from user, agent, project, and package skill directories. */
function discoverSkills(cwd: string): string[] {
	const agentDir = getAgentDir();
	const names = new Set<string>();
	const collect = (dir: string): void => {
		if (!existsSync(dir)) return;
		for (const entry of safeReaddir(dir)) {
			if (existsSync(join(dir, entry, "SKILL.md"))) names.add(entry);
		}
	};
	collect(join(agentDir, "skills"));
	collect(join(homedir(), ".agents", "skills"));
	collect(join(cwd, ".pi", "skills"));
	// Package skills: node_modules/<pkg>/skills/<skill>/ and @<scope>/<pkg>/skills/<skill>/
	const nm = join(agentDir, "npm", "node_modules");
	if (existsSync(nm)) {
		for (const pkg of safeReaddir(nm)) {
			if (pkg.startsWith(".")) continue;
			const pkgPath = join(nm, pkg);
			if (pkg.startsWith("@")) {
				for (const sub of safeReaddir(pkgPath)) {
					collect(join(pkgPath, sub, "skills"));
				}
			} else {
				collect(join(pkgPath, "skills"));
			}
		}
	}
	return [...names].sort();
}

/** Path segments that carry no identity when naming an extension entry. */
const GENERIC_SEGMENTS = new Set(["index", "main", "extension", "extensions", "src", "dist", "lib", ".", ".."]);

/** Human name for a settings entry: `npm:pi-web-access` → pi-web-access,
 *  `/…/better-claude-code-ui/extension/index.ts` → better-claude-code-ui. */
export function extensionDisplayName(entry: string): string {
	const spec = entry.replace(/^(npm|git|file):/, "");
	const segments = spec.split("/").filter(Boolean);
	for (let i = segments.length - 1; i >= 0; i--) {
		const base = segments[i]!.replace(/\.(ts|js)$/, "");
		if (!GENERIC_SEGMENTS.has(base)) return base;
	}
	return spec;
}

function readSettingsArray(path: string, key: string): string[] {
	try {
		if (!existsSync(path)) return [];
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const v = raw[key];
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Discover extension names the way pi actually loads them: the drop-in
 * `<agentDir>/extensions/` dir PLUS the `extensions` (path entries) and
 * `packages` (npm:/git: specs) arrays of the global, agent, and project
 * settings.json. `-`/`!` entries are exclusion patterns that apply to OTHER
 * entries, so they're collected first and then filtered out of the display set.
 */
function discoverExtensions(cwd: string): string[] {
	const names = new Set<string>();
	const dir = join(getAgentDir(), "extensions");
	if (existsSync(dir)) {
		for (const f of safeReaddir(dir)) {
			if (f.endsWith(".ts") || f.endsWith(".js")) names.add(f.replace(/\.(ts|js)$/, ""));
		}
	}
	const settingsFiles = [
		join(homedir(), ".pi", "settings.json"),
		join(getAgentDir(), "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];
	const excluded = new Set<string>();
	const candidates: string[] = [];
	for (const file of settingsFiles) {
		for (const entry of [...readSettingsArray(file, "extensions"), ...readSettingsArray(file, "packages")]) {
			if (entry.startsWith("-") || entry.startsWith("!")) {
				excluded.add(extensionDisplayName(entry.slice(1)));
				continue;
			}
			candidates.push(entry.replace(/^\+/, ""));
		}
	}
	for (const entry of candidates) {
		const name = extensionDisplayName(entry);
		if (!excluded.has(name)) names.add(name);
	}
	for (const name of excluded) names.delete(name);
	return [...names].sort();
}

/** Pack names into comma-separated rows that fit `width`, with a "+N more" tail. */
function packNames(names: readonly string[], width: number, maxRows: number): string[] {
	if (names.length === 0) return [];
	const joined = (parts: readonly string[]): string => parts.join(", ");
	const rows: string[] = [];
	let row: string[] = [];
	let placed = 0;
	for (const name of names) {
		if (row.length === 0 || visibleWidth(joined([...row, name])) <= width) {
			row.push(name);
			placed += 1;
			continue;
		}
		if (rows.length + 1 === maxRows) break;
		rows.push(joined(row));
		row = [name];
		placed += 1;
	}
	let hidden = names.length - placed;
	if (hidden > 0) {
		while (row.length > 0 && visibleWidth(joined([...row, `+${hidden} more`])) > width) {
			row.pop();
			hidden += 1;
		}
		row.push(`+${hidden} more`);
	}
	rows.push(joined(row));
	return rows;
}

export class BannerComponent {
	// Render cache: the header is re-rendered every frame by the TUI, and the
	// box is static once the session is up — recompute only when an input flips.
	private cacheKey: string | undefined;
	private cacheTheme: Theme | undefined;
	private cacheLines: string[] | undefined;

	private readonly info: BannerInfo;

	constructor(info: BannerInfo) {
		this.info = info;
	}

	invalidate(): void {
		this.cacheKey = undefined;
		this.cacheTheme = undefined;
		this.cacheLines = undefined;
	}

	render(width: number, theme: Theme): string[] {
		// Key on every input the output depends on. model/title are dynamic
		// getters; a model/session change flips the key and recomputes.
		const key = [
			width,
			typeof theme.getColorMode === "function" ? theme.getColorMode() : "",
			this.info.model() ?? "",
			this.info.title() ?? "",
			this.info.resumed ?? "",
		].join(" ");
		if (this.cacheLines && this.cacheKey === key && this.cacheTheme === theme) {
			return this.cacheLines;
		}
		const rows = !this.info.full
			? this.renderCondensed(width, theme)
			: width >= FULL_MIN_WIDTH
				? this.renderWide(width, theme)
				: width >= MIN_BOXED_WIDTH
					? this.renderBoxed(width, theme)
					: this.renderCompact(width, theme);
		this.cacheKey = key;
		this.cacheTheme = theme;
		this.cacheLines = rows;
		return rows;
	}

	private border(theme: Theme, text: string): string {
		return theme.fg("accent", text);
	}

	/** The `resumed <id8> · <title>` identity line, or undefined on a fresh session. */
	private resumedLine(): string | undefined {
		if (this.info.resumed === undefined) return undefined;
		const title = this.info.title();
		return `resumed ${this.info.resumed}` + (title ? ` · ${title}` : "");
	}

	/**
	 * Default startup logo: a borderless stack, Pi+ mark left of a 3-line info
	 * column (`pi+ agent vX` / model / cwd), plus the resumed line when
	 * resuming. Mirrors the reference CondensedLogo tier.
	 */
	private renderCondensed(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const bold = (s: string): string => theme.bold(s);

		const logoWidth = Math.max(...PI_PLUS_LOGO.map((row) => visibleWidth(row)));
		// Too narrow to sit the info column beside the mark → borderless centered
		// stack (same degradation as the compact box, no overflow).
		if (width < logoWidth + 4 + 8) return this.renderCompactPlain(width, theme);
		const textWidth = Math.max(width - logoWidth - 4, 20);
		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, textWidth);
		const resumed = this.resumedLine();

		const info: string[] = [
			`${bold(APP_LABEL)} ${dim(`v${PLUS_VERSION}`)}`,
			...(model ? [dim(truncateToWidth(model, textWidth, "…"))] : []),
			dim(cwd),
			...(resumed ? [dim(truncateToWidth(resumed, textWidth, "…"))] : []),
		];

		const height = Math.max(PI_PLUS_LOGO.length, info.length);
		const rows: string[] = [];
		for (let i = 0; i < height; i++) {
			const art = PI_PLUS_LOGO[i] ?? " ".repeat(logoWidth);
			const line = i < info.length ? info[i] : "";
			rows.push(truncateToWidth(` ${accent(art)}  ${line}`, Math.max(1, width), ""));
		}
		return rows;
	}

	/**
	 * Wide tier (>=76 cols, reference renderFull): two-column box spanning the
	 * terminal, `pi+ agent vX` wordmark in the top border, the Pi+ mark with the
	 * identity stack on the left, Extensions/Skills feeds on the right of a
	 * vertical divider.
	 */
	private renderWide(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, MAX_LEFT_WIDTH - 4);
		const resumed = this.resumedLine();
		const logoWidth = Math.max(...PI_PLUS_LOGO.map((row) => visibleWidth(row)));

		// Left panel width (reference: max(content, 20) + 4, capped at 50),
		// floored so the Pi+ mark always fits.
		const leftWidth = Math.min(
			Math.max(
				visibleWidth(welcome),
				visibleWidth(cwd),
				visibleWidth(model),
				visibleWidth(resumed ?? ""),
				logoWidth,
				MIN_LEFT_WIDTH,
			) + 4,
			MAX_LEFT_WIDTH,
		);
		const boxWidth = width; // adaptive: full terminal width
		// 7 = 2 borders + 2 paddingX + 1 divider + 2 gaps.
		const rightWidth = boxWidth - leftWidth - 7;
		// Not enough room for the right panel → fall back to the boxed tier.
		if (rightWidth < RIGHT_MIN_WIDTH) return this.renderBoxed(width, theme);

		// Identity lines share one left edge (individually centering lines of
		// very different lengths gives a ragged edge that reads as misalignment).
		const identity: string[] = [...(model ? [dim(model)] : []), dim(cwd), ...(resumed ? [dim(resumed)] : [])];
		const identityLead = Math.max(
			0,
			Math.floor((leftWidth - Math.max(...identity.map((l) => visibleWidth(l)), 0)) / 2),
		);

		// Left panel (centered, space-between: welcome / logo / identity stack).
		const leftRows: string[] = [
			"",
			center(bold(welcome), leftWidth),
			"",
			...PI_PLUS_LOGO.map((row) => center(accent(row), leftWidth)),
			"",
			...identity.map((l) => " ".repeat(identityLead) + truncateToWidth(l, leftWidth - 2, "")),
		];

		// Right panel: Extensions + Skills feeds (live from disk).
		const rightRows: string[] = [];
		const exts = this.info.extensions ?? [];
		const skills = this.info.skills ?? [];
		if (exts.length > 0) {
			rightRows.push(bold(accent("Extensions")));
			for (const line of packNames(exts, rightWidth, 2)) {
				rightRows.push(truncateToWidth(line, rightWidth, ""));
			}
		}
		if (skills.length > 0) {
			if (rightRows.length > 0) rightRows.push(accent("─".repeat(rightWidth)));
			rightRows.push(bold(accent("Skills")));
			for (const line of packNames(skills, rightWidth, SKILLS_MAX_ROWS)) {
				rightRows.push(truncateToWidth(line, rightWidth, ""));
			}
		}

		const height = Math.max(leftRows.length, rightRows.length);
		const rows: string[] = [];

		// Top border with embedded wordmark: ╭─── pi+ agent vX ──fill──╮
		const titlePlain = `${APP_LABEL} v${PLUS_VERSION}`;
		const titleColored = `${accent(APP_LABEL)} ${dim(`v${PLUS_VERSION}`)}`;
		const fillLen = boxWidth - 1 - 3 - 1 - visibleWidth(titlePlain) - 1 - 1;
		rows.push(
			`${this.border(theme, "╭───")} ${titleColored} ${this.border(theme, "─".repeat(Math.max(0, fillLen)) + "╮")}`,
		);

		// Content rows: │ left │ right │
		for (let i = 0; i < height; i++) {
			const left = i < leftRows.length ? leftRows[i] : "";
			const right = i < rightRows.length ? rightRows[i] : "";
			rows.push(
				`${this.border(theme, "│")} ${padRight(left, leftWidth)} ${this.border(theme, "│")} ${padRight(right, rightWidth)} ${this.border(theme, "│")}`,
			);
		}

		// Bottom border
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		return rows;
	}

	/**
	 * Boxed tier (>=40 cols): a single rounded box that hugs its content — the
	 * Pi+ mark left, the identity stack right — with the Extensions/Skills feeds
	 * as a borderless trailer under the box.
	 */
	private renderBoxed(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);

		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, MAX_LEFT_WIDTH - 4);
		const resumed = this.resumedLine();

		const lines: string[] = [
			`${accent(APP_LABEL)} ${dim(`v${PLUS_VERSION}`)}`,
			...(model ? [dim(model)] : []),
			dim(cwd),
			...(resumed ? [dim(resumed)] : []),
		];
		const logoWidth = Math.max(...PI_PLUS_LOGO.map((row) => visibleWidth(row)));
		// Chrome beyond logo + text: 2 borders + 2 padding + 2 gap.
		const overhead = logoWidth + 6;
		const textWidth = Math.min(Math.max(...lines.map((line) => visibleWidth(line))), Math.max(1, width - overhead));
		const boxWidth = overhead + textWidth;

		const rows: string[] = [this.border(theme, `╭${"─".repeat(boxWidth - 2)}╮`)];
		const height = Math.max(PI_PLUS_LOGO.length, lines.length);
		for (let i = 0; i < height; i++) {
			const art = PI_PLUS_LOGO[i] ?? " ".repeat(logoWidth);
			const text = i < lines.length ? truncateToWidth(lines[i], textWidth, "") : "";
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(text)));
			rows.push(`${this.border(theme, "│")} ${accent(art)}  ${text}${pad} ${this.border(theme, "│")}`);
		}
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		rows.push(...this.renderBoxedTrailer(width, theme));
		return rows;
	}

	/** Borderless welcome + Extensions/Skills feeds under the boxed banner, indented 1. */
	private renderBoxedTrailer(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const bold = (s: string): string => theme.bold(s);
		const usable = Math.max(1, width - 2);
		const rows: string[] = [` ${dim(this.info.welcome ?? "Welcome back!")}`];
		const section = (label: string, names: readonly string[], maxRows: number): void => {
			if (names.length === 0) return;
			rows.push("");
			rows.push(` ${bold(accent(label))}`);
			for (const line of packNames(names, usable, maxRows)) {
				rows.push(` ${dim(truncateToWidth(line, usable, ""))}`);
			}
		};
		section("Extensions", this.info.extensions ?? [], 2);
		section("Skills", this.info.skills ?? [], SKILLS_MAX_ROWS);
		return rows;
	}

	private renderCompact(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const resumed = this.resumedLine();

		const contentWidth = Math.max(
			...PI_PLUS_LOGO.map((row) => visibleWidth(row)),
			visibleWidth(welcome),
			visibleWidth(model),
			visibleWidth(resumed ?? ""),
			20,
		);
		const boxWidth = Math.min(contentWidth + 4, Math.max(0, width - 2));
		// The titled top border `╭── pi+ agent ──╮` is a fixed 15-col scaffold
		// (3 + 1 + 9 + 1 + fill + 1); below that its fill length goes negative
		// (`"─".repeat(负数)` → RangeError) and the border overflows the box.
		// Degrade to a borderless centered stack instead of crashing.
		if (boxWidth < 15) return this.renderCompactPlain(width, theme);
		const inner = boxWidth - 4;
		const cwd = truncatePath(this.info.cwd, inner);

		const rows: string[] = [];
		const titlePlain = APP_LABEL;
		const fillLen = boxWidth - 1 - 2 - 1 - visibleWidth(titlePlain) - 1 - 1;
		rows.push(
			`${this.border(theme, "╭──")} ${accent(titlePlain)} ${this.border(theme, "─".repeat(Math.max(0, fillLen)) + "╮")}`,
		);
		rows.push(`${this.border(theme, "│")} ${center(bold(welcome), inner)} ${this.border(theme, "│")}`);
		for (const artRow of PI_PLUS_LOGO) {
			rows.push(`${this.border(theme, "│")} ${center(accent(artRow), inner)} ${this.border(theme, "│")}`);
		}
		if (model) rows.push(`${this.border(theme, "│")} ${center(dim(model), inner)} ${this.border(theme, "│")}`);
		rows.push(`${this.border(theme, "│")} ${center(dim(cwd), inner)} ${this.border(theme, "│")}`);
		if (resumed) rows.push(`${this.border(theme, "│")} ${center(dim(resumed), inner)} ${this.border(theme, "│")}`);
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		return rows;
	}

	/**
	 * Borderless fallback for terminals too narrow to hold the compact box.
	 * A centered title/welcome/cwd stack clamped to the available width — no
	 * box chrome, so no negative `"─".repeat`.
	 */
	private renderCompactPlain(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = (s: string): string => theme.fg("accent", s);
		const bold = (s: string): string => theme.bold(s);
		const w = Math.max(1, width);
		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const resumed = this.resumedLine();
		const cwd = truncatePath(this.info.cwd, w);
		const rows: string[] = [center(accent(APP_LABEL), w), center(bold(welcome), w)];
		if (model) rows.push(center(dim(model), w));
		rows.push(center(dim(cwd), w));
		if (resumed) rows.push(center(dim(resumed), w));
		return rows;
	}
}

export function registerBanner(pi: ExtensionAPI): void {
	pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const resumed =
			event.reason === "resume" || event.reason === "fork"
				? (ctx.sessionManager.getSessionId() ?? "").slice(0, 8) || undefined
				: undefined;
		const banner = new BannerComponent({
			model: () => ctx.model?.id,
			cwd: tildeHome(ctx.cwd),
			resumed,
			title: () => ctx.sessionManager.getSessionName(),
			skills: discoverSkills(ctx.cwd),
			extensions: discoverExtensions(ctx.cwd),
			full: true,
		});
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return banner.render(width, theme);
			},
			invalidate() {
				banner.invalidate();
			},
		}));
	});
}
