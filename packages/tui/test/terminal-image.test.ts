/**
 * Tests for terminal image detection and line handling
 */

import assert from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	detectCapabilities,
	hyperlink,
	isImageLine,
	parsePrimaryDeviceAttributesSixelSupport,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	shouldAutoDetectSixel,
} from "../src/terminal-image.js";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"WSL_DISTRO_NAME",
	"WSL_INTEROP",
	"WSLENV",
	"PI_TUI_IMAGE_PROTOCOL",
	"PI_TUI_SIXEL_ENCODER",
] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	resetCapabilitiesCache();
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		resetCapabilitiesCache();
	}
}

function createFakeSixelEncoder(
	baseName = "fake-img2sixel",
	versionExitCode = 0,
): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-tui-sixel-test-"));
	const programPath = join(dir, `${baseName}.js`);
	writeFileSync(
		programPath,
		`const args = process.argv.slice(2);
const versionExitCode = ${versionExitCode};
if (args.includes("--version") || args.includes("-V")) {
	if (versionExitCode !== 0) {
		process.stderr.write("fake encoder version check failed\\n");
		process.exit(versionExitCode);
	}
	process.stdout.write("fake encoder 1.0\\n");
	process.exit(0);
}
process.stdout.write("\\x1bPqMOCK:" + args.join("|") + "\\x1b\\\\\\n");
`,
	);

	if (process.platform === "win32") {
		const wrapperPath = join(dir, `${baseName}.cmd`);
		writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${programPath}" %*\r\n`);
		return {
			path: wrapperPath,
			cleanup: () => rmSync(dir, { recursive: true, force: true }),
		};
	}

	const wrapperPath = join(dir, baseName);
	writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${programPath}" "$@"\n`);
	chmodSync(wrapperPath, 0o755);
	return {
		path: wrapperPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

afterEach(() => {
	resetCapabilitiesCache();
	setCellDimensions({ widthPx: 9, heightPx: 18 });
});

describe("isImageLine", () => {
	describe("iTerm2 image protocol", () => {
		it("should detect iTerm2 image escape sequence at start of line", () => {
			// iTerm2 image escape sequence: ESC ]1337;File=...
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			assert.strictEqual(isImageLine(iterm2ImageLine), true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			assert.strictEqual(isImageLine(lineWithTextAndImage), true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			assert.strictEqual(isImageLine(longLineWithImage), true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImageAtEnd), true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			assert.strictEqual(isImageLine(minimalImageLine), true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(kittyImageLine), true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			assert.strictEqual(isImageLine(lineWithTextAndKittyImage), true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			assert.strictEqual(isImageLine(kittyWithPadding), true);
		});
	});

	describe("SIXEL image protocol", () => {
		it("should detect SIXEL image escape sequence at start of line", () => {
			const sixelImageLine = "\x1bPq~~@@~~\x1b\\";
			assert.strictEqual(isImageLine(sixelImageLine), true);
		});

		it("should detect SIXEL image escape sequence with parameters", () => {
			const sixelImageLine = "\x1bP0;0;0q#0;2;0;0;0-~~\x1b\\";
			assert.strictEqual(isImageLine(sixelImageLine), true);
		});

		it("should detect SIXEL image escape sequence after cursor movement", () => {
			const sixelImageLine = "\x1b[4A\x1bPq#0~~~~\x1b\\";
			assert.strictEqual(isImageLine(sixelImageLine), true);
		});
	});

	describe("Bug regression tests", () => {
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			// This simulates the crash scenario: a line with 304,401 chars
			// containing image escape sequences somewhere
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a long line with image sequence
			const longLine =
				"Text prefix " +
				imageSequence +
				base64Char.repeat(3000) + // ~300,000 chars
				" suffix";

			assert.strictEqual(longLine.length > 300000, true);
			assert.strictEqual(isImageLine(longLine), true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			assert.strictEqual(isImageLine(lineWithImage), true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			assert.strictEqual(isImageLine(lineWithAnsiAndImage), true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			assert.strictEqual(isImageLine(lineWithImageAndAnsi), true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			assert.strictEqual(isImageLine(plainText), false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			assert.strictEqual(isImageLine(ansiText), false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			assert.strictEqual(isImageLine(cursorCodes), false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with _G but missing ESC at start";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in lines with partial SIXEL sequences", () => {
			const partialSequence = "Some text with \x1bP but missing the q introducer";
			assert.strictEqual(isImageLine(partialSequence), false);
		});

		it("should not detect images in empty lines", () => {
			assert.strictEqual(isImageLine(""), false);
		});

		it("should not detect images in lines with newlines only", () => {
			assert.strictEqual(isImageLine("\n"), false);
			assert.strictEqual(isImageLine("\n\n"), false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			assert.strictEqual(isImageLine(mixedLine), true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			assert.strictEqual(isImageLine(complexLine), true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			assert.strictEqual(isImageLine(filePathLine), false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false under tmux even if outer terminal supports OSC 8", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, false);
			assert.strictEqual(caps.images, null);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
		});
	});

	it("keeps Windows Terminal on text fallback until runtime SIXEL probing succeeds", () => {
		withEnv({ WT_SESSION: "1" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("keeps VSCode on text fallback until runtime SIXEL probing succeeds", () => {
		withEnv({ TERM_PROGRAM: "vscode", WSL_DISTRO_NAME: "Ubuntu" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("allows PI_TUI_IMAGE_PROTOCOL to force SIXEL", () => {
		withEnv({ PI_TUI_IMAGE_PROTOCOL: "sixel" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.images, "sixel");
		});
	});

	it("allows PI_TUI_IMAGE_PROTOCOL to disable images", () => {
		withEnv({ WT_SESSION: "1", PI_TUI_IMAGE_PROTOCOL: "none" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});

	it("probes SIXEL support only when no image protocol is already selected", () => {
		const encoder = createFakeSixelEncoder();
		try {
			withEnv({ PI_TUI_SIXEL_ENCODER: encoder.path }, () => {
				const caps = detectCapabilities();
				assert.strictEqual(caps.images, null);
				assert.strictEqual(shouldAutoDetectSixel(caps), true);
			});
		} finally {
			encoder.cleanup();
		}
	});

	it("does not probe SIXEL under tmux by default", () => {
		const encoder = createFakeSixelEncoder();
		try {
			withEnv({ PI_TUI_SIXEL_ENCODER: encoder.path, TERM: "tmux-256color" }, () => {
				const caps = detectCapabilities();
				assert.strictEqual(caps.images, null);
				assert.strictEqual(shouldAutoDetectSixel(caps), false);
			});
		} finally {
			encoder.cleanup();
		}
	});

	it("does not probe SIXEL when encoder health check exits non-zero", () => {
		const encoder = createFakeSixelEncoder("fake-img2sixel-failing", 1);
		try {
			withEnv({ PI_TUI_SIXEL_ENCODER: encoder.path }, () => {
				const caps = detectCapabilities();
				assert.strictEqual(caps.images, null);
				assert.strictEqual(shouldAutoDetectSixel(caps), false);
			});
		} finally {
			encoder.cleanup();
		}
	});

	it("enables hyperlinks for VSCode outside Windows and WSL", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			assert.strictEqual(caps.hyperlinks, true);
			assert.strictEqual(caps.images, null);
		});
	});
});

describe("parsePrimaryDeviceAttributesSixelSupport", () => {
	it("detects SIXEL support from DA1 responses", () => {
		assert.strictEqual(parsePrimaryDeviceAttributesSixelSupport("\x1b[?62;4;22c"), true);
		assert.strictEqual(parsePrimaryDeviceAttributesSixelSupport("\x1b[?1;2c"), false);
	});

	it("returns null for non-DA1 responses", () => {
		assert.strictEqual(parsePrimaryDeviceAttributesSixelSupport("\x1b[6;20;10t"), null);
	});
});

describe("renderImage", () => {
	it("renders SIXEL output via img2sixel", () => {
		const encoder = createFakeSixelEncoder();
		try {
			withEnv({ PI_TUI_SIXEL_ENCODER: encoder.path }, () => {
				setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
				setCellDimensions({ widthPx: 10, heightPx: 20 });
				const result = renderImage(
					Buffer.from("fake").toString("base64"),
					{ widthPx: 200, heightPx: 100 },
					{
						maxWidthCells: 20,
					},
				);

				assert.ok(result);
				assert.strictEqual(result.rows, 5);
				assert.ok(result.sequence.startsWith("\x1bPqMOCK:"));
				assert.ok(result.sequence.includes("-w|200px|"));
				assert.ok(!result.sequence.includes("|-h|"));
			});
		} finally {
			encoder.cleanup();
		}
	});

	it("falls back when SIXEL encoder is unavailable", () => {
		withEnv({ PI_TUI_SIXEL_ENCODER: "/definitely/not/present/pi-tui-sixel-encoder" }, () => {
			setCapabilities({ images: "sixel", trueColor: true, hyperlinks: true });
			const result = renderImage(
				Buffer.from("fake").toString("base64"),
				{ widthPx: 200, heightPx: 100 },
				{
					maxWidthCells: 20,
				},
			);
			assert.strictEqual(result, null);
		});
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		assert.ok(result.startsWith("\x1b]8;;https://example.com\x1b\\"));
		assert.ok(result.includes(styled));
		assert.ok(result.endsWith("\x1b]8;;\x1b\\"));
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		assert.strictEqual(result, "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		assert.ok(result.includes("file:///home/user/README.md"));
		assert.ok(result.includes("README.md"));
	});
});
