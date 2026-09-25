import { backgroundAnsi, foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * The pi logo: 4 cells wide and 2 lines tall. Each cell shows two square pixels with half blocks:
 *
 *   coral coral coral .
 *   blue  .     coral .
 *   blue  blue  .     yellow
 *   blue  .     .     yellow
 *
 * The brand colors stay fixed across themes; they follow the terminal's color mode.
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	// The fourth cell of the top line is empty, so it is padded to the same width as the bottom line.
	const top = `${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${RESET}${fg(CORAL)}▀█${RESET} `;
	const bottom = `${fg(BLUE)}█▀${RESET} ${fg(YELLOW)}█${RESET}`;
	return [top, bottom];
}
