import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ImageProtocol = "kitty" | "iterm2" | "sixel" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	imageId?: number;
}

interface SixelEncoder {
	command: string;
}

let cachedCapabilities: TerminalCapabilities | null = null;
let cachedSixelEncoder: SixelEncoder | null | undefined;

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

function getImageProtocolOverride(): ImageProtocol | "none" | undefined {
	const value = process.env.PI_TUI_IMAGE_PROTOCOL?.trim().toLowerCase();
	if (!value || value === "auto") {
		return undefined;
	}
	if (value === "kitty" || value === "iterm2" || value === "sixel") {
		return value;
	}
	if (value === "none" || value === "off" || value === "false") {
		return "none";
	}
	return undefined;
}

function isTmuxOrScreen(term: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return !!env.TMUX || term.startsWith("tmux") || term.startsWith("screen");
}

export function detectCapabilities(): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const imageProtocolOverride = getImageProtocolOverride();
	const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";

	let images: ImageProtocol = null;
	let hyperlinks = false;
	let terminalTrueColor = trueColor;

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		images = "kitty";
		hyperlinks = true;
		terminalTrueColor = true;
	} else if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		images = "kitty";
		hyperlinks = true;
		terminalTrueColor = true;
	} else if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		images = "kitty";
		hyperlinks = true;
		terminalTrueColor = true;
	} else if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		images = "iterm2";
		hyperlinks = true;
		terminalTrueColor = true;
	} else if (process.env.WT_SESSION) {
		hyperlinks = true;
		terminalTrueColor = true;
	} else if (termProgram === "vscode") {
		hyperlinks = true;
		terminalTrueColor = true;
	} else if (termProgram === "alacritty") {
		hyperlinks = true;
		terminalTrueColor = true;
	}

	// tmux and screen swallow OSC 8 by default (passthrough is opt-in and wraps
	// sequences differently). Force hyperlinks off whenever we detect them, even
	// when the outer terminal would otherwise support OSC 8. Image protocols are
	// also unreliable under tmux/screen, so leave `images: null` for safety unless
	// the user explicitly overrides the image protocol.
	const inTmuxOrScreen = isTmuxOrScreen(term);
	if (inTmuxOrScreen) {
		hyperlinks = false;
		if (imageProtocolOverride === undefined) {
			images = null;
		}
	}

	if (imageProtocolOverride !== undefined) {
		images = imageProtocolOverride === "none" ? null : imageProtocolOverride;
	}

	return { images, trueColor: terminalTrueColor, hyperlinks };
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		cachedCapabilities = detectCapabilities();
	}
	return cachedCapabilities;
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
	cachedSixelEncoder = undefined;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
const SIXEL_PREFIX = "\x1bP";
const SIXEL_START_PATTERN = /\x1bP(?:[0-9;]*)q/;
const PRIMARY_DEVICE_ATTRIBUTES_PATTERN = /^\x1b\[\??([0-9;]*)c$/;
const SIXEL_ENCODER_CHECK_TIMEOUT_MS = 1000;
const SIXEL_ENCODE_TIMEOUT_MS = 5000;

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (
		line.startsWith(KITTY_PREFIX) ||
		line.startsWith(ITERM2_PREFIX) ||
		(line.startsWith(SIXEL_PREFIX) && SIXEL_START_PATTERN.test(line))
	) {
		return true;
	}

	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	return (
		line.includes(KITTY_PREFIX) ||
		line.includes(ITERM2_PREFIX) ||
		(line.includes(SIXEL_PREFIX) && SIXEL_START_PATTERN.test(line))
	);
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 */
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId}\x1b\\`;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
	return `\x1b_Ga=d,d=A\x1b\\`;
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

function detectSixelEncoder(): SixelEncoder | null {
	if (cachedSixelEncoder !== undefined) {
		return cachedSixelEncoder;
	}

	const explicitCommand = process.env.PI_TUI_SIXEL_ENCODER?.trim();
	if (explicitCommand) {
		const encoder: SixelEncoder = { command: explicitCommand };
		const check = spawnSync(encoder.command, ["-V"], {
			encoding: "utf8",
			timeout: SIXEL_ENCODER_CHECK_TIMEOUT_MS,
		});
		cachedSixelEncoder = check.error || check.status !== 0 ? null : encoder;
		return cachedSixelEncoder;
	}

	const encoder: SixelEncoder = { command: "img2sixel" };
	const check = spawnSync(encoder.command, ["-V"], {
		encoding: "utf8",
		timeout: SIXEL_ENCODER_CHECK_TIMEOUT_MS,
	});
	cachedSixelEncoder = check.error || check.status !== 0 ? null : encoder;
	return cachedSixelEncoder;
}

function buildSixelArgs(inputPath: string, columns: number, rows: number, preserveAspectRatio: boolean): string[] {
	const dims = getCellDimensions();
	const widthPx = Math.max(1, Math.round(columns * dims.widthPx));
	const heightPx = Math.max(1, Math.round(rows * dims.heightPx));
	const args = ["-w", `${widthPx}px`];
	if (!preserveAspectRatio) {
		args.push("-h", `${heightPx}px`);
	}
	args.push(inputPath);
	return args;
}

export function shouldAutoDetectSixel(caps: TerminalCapabilities = getCapabilities()): boolean {
	if (getImageProtocolOverride() !== undefined) {
		return false;
	}
	if (caps.images) {
		return false;
	}
	const term = process.env.TERM?.toLowerCase() || "";
	if (isTmuxOrScreen(term)) {
		return false;
	}
	return detectSixelEncoder() !== null;
}

export function parsePrimaryDeviceAttributesSixelSupport(response: string): boolean | null {
	const match = response.match(PRIMARY_DEVICE_ATTRIBUTES_PATTERN);
	if (!match) {
		return null;
	}
	return match[1].split(";").some((param) => param === "4");
}

export function encodeSixel(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		preserveAspectRatio?: boolean;
	} = {},
): string | null {
	const encoder = detectSixelEncoder();
	if (!encoder) {
		return null;
	}

	const columns = Math.max(1, options.columns ?? 80);
	const rows = Math.max(1, options.rows ?? 24);
	const preserveAspectRatio = options.preserveAspectRatio ?? true;
	const tempDir = mkdtempSync(join(tmpdir(), "pi-tui-sixel-"));
	const inputPath = join(tempDir, "image.bin");

	try {
		writeFileSync(inputPath, Buffer.from(base64Data, "base64"));
		const result = spawnSync(encoder.command, buildSixelArgs(inputPath, columns, rows, preserveAspectRatio), {
			encoding: "utf8",
			maxBuffer: 20 * 1024 * 1024,
			timeout: SIXEL_ENCODE_TIMEOUT_MS,
		});

		if (result.error || result.status !== 0 || !result.stdout) {
			return null;
		}

		const sequence = result.stdout.replace(/[\r\n]+$/, "");
		if (!SIXEL_START_PATTERN.test(sequence)) {
			return null;
		}
		return sequence;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);
	return Math.max(1, rows);
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; rows: number; imageId?: number } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const rows = calculateImageRows(imageDimensions, maxWidth, getCellDimensions());

	if (caps.images === "kitty") {
		// Only use imageId if explicitly provided - static images don't need IDs
		const sequence = encodeKitty(base64Data, { columns: maxWidth, rows, imageId: options.imageId });
		return { sequence, rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: maxWidth,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows };
	}

	if (caps.images === "sixel") {
		const sequence = encodeSixel(base64Data, {
			columns: maxWidth,
			rows,
			preserveAspectRatio: options.preserveAspectRatio,
		});
		if (!sequence) {
			return null;
		}
		return { sequence, rows };
	}

	return null;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, Windows Terminal, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
