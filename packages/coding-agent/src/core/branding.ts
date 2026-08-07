// MatwingsVenus branding constants and welcome banner.
//
// The display version/tagline here are decoupled from the npm package version
// (config.ts VERSION) so the banner can show a branded release string.

/** Display version shown in the banner (decoupled from the npm package version). */
export const DISPLAY_VERSION = "v1.0.0-beta";

/** Tagline shown next to the version in the banner. */
export const DISPLAY_TAGLINE = "AI4Science Engine Active";

/** Welcome heading shown below the banner after a successful login. */
export const WELCOME_HEADING = "Welcome to MatwingsVenus. The SAION AI Scientist is ready.";

/** Hint line shown below the heading. */
export const WELCOME_HINT = "Type /help to see available commands, or /exit to quit.";

/** Full product display name used in user-visible copy. */
export const PRODUCT_NAME = "MatwingsVenus";

/** ASCII art for the top word (no box padding; rendered centered). */
export const MATWINGS_ART: readonly string[] = [
	"███╗   ███╗ █████╗ ████████╗██╗    ██╗██╗███╗   ██╗ ██████╗ ███████╗",
	"████╗ ████║██╔══██╗╚══██╔══╝██║    ██║██║████╗  ██║██╔════╝ ██╔════╝",
	"██╔████╔██║███████║   ██║   ██║ █╗ ██║██║██╔██╗ ██║██║  ███╗███████╗",
	"██║╚██╔╝██║██╔══██║   ██║   ██║███╗██║██║██║╚██╗██║██║   ██║╚════██║",
	"██║ ╚═╝ ██║██║  ██║   ██║   ╚███╔███╔╝██║██║ ╚████║╚██████╔╝███████║",
	"╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝    ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝",
];

/** ASCII art for the bottom word (no box padding; rendered centered). */
export const VENUS_ART: readonly string[] = [
	"██╗   ██╗███████╗███╗   ██╗██╗   ██╗███████╗",
	"██║   ██║██╔════╝████╗  ██║██║   ██║██╔════╝",
	"██║   ██║█████╗  ██╔██╗ ██║██║   ██║███████╗",
	"╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██║   ██║╚════██║",
	" ╚████╔╝ ███████╗██║ ╚████║╚██████╔╝███████║",
	"  ╚═══╝  ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝",
];

/** Interior width of the banner box, in terminal columns. */
const BANNER_WIDTH = 74;

/** Center a line within `width` columns (left-biased padding). */
function centerPad(line: string, width: number): string {
	if (line.length >= width) return line.slice(0, width);
	const total = width - line.length;
	const left = Math.floor(total / 2);
	return `${" ".repeat(left)}${line}${" ".repeat(total - left)}`;
}

/**
 * Render the boxed MATWINGS/VENUS banner with the version + tagline line.
 * Returns the banner as a single multi-line string (no trailing newline).
 */
export function renderWelcomeBanner(): string {
	const horizontal = "─".repeat(BANNER_WIDTH);
	const lines: string[] = [];
	lines.push(`╭${horizontal}╮`);
	const blank = " ".repeat(BANNER_WIDTH);
	const push = (content: string): void => {
		lines.push(`│${content}│`);
	};
	push(blank);
	for (const art of MATWINGS_ART) push(centerPad(art, BANNER_WIDTH));
	push(blank);
	for (const art of VENUS_ART) push(centerPad(art, BANNER_WIDTH));
	push(blank);
	push(centerPad(`${DISPLAY_VERSION} • ${DISPLAY_TAGLINE}`, BANNER_WIDTH));
	push(blank);
	lines.push(`╰${horizontal}╯`);
	return lines.join("\n");
}
