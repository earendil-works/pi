/**
 * Opens rendered HTML in a Glimpse WKWebView window (primary)
 * or falls back to the default browser (secondary).
 *
 * Glimpse windows open at 2/3 of typical screen size and support
 * bidirectional messaging: the textarea in the HTML sends
 * { type: "submit", text: "..." } back to the host.
 */
import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Approximate 2/3 of a standard display — works well on 1080p through 4K */
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;

export interface OpenViewOptions {
	/** Session ID for temp file scoping (concurrency safe) */
	sessionId: string;
	/** Window title for Glimpse */
	title?: string;
	/** Called when the user submits a message from the Glimpse textarea */
	onSubmit?: (text: string) => void;
}

export type OpenViewResult = { method: "glimpse" | "browser"; path: string };

/**
 * Open HTML content in a Glimpse window (preferred) or default browser (fallback).
 *
 * The Glimpse window:
 * - Opens at ~2/3 screen size (1200x800 default)
 * - Listens for submit messages from the in-page textarea
 * - Calls onSubmit(text) when the user presses Enter in the textarea
 *
 * Browser fallback does not support submit (write-only).
 */
export async function openView(html: string, options: OpenViewOptions): Promise<OpenViewResult> {
	const filename = `mu-view-${options.sessionId}.html`;
	const filePath = join(tmpdir(), filename);
	writeFileSync(filePath, html, "utf-8");

	// Try Glimpse first
	try {
		const { open } = await import("glimpseui");

		const win = open(html, {
			width: DEFAULT_WIDTH,
			height: DEFAULT_HEIGHT,
			title: options.title ?? "mu /view",
		});

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				openFallback(filePath);
				resolve({ method: "browser", path: filePath });
			}, 4000);

			win.on("ready", () => {
				clearTimeout(timeout);
				resolve({ method: "glimpse", path: filePath });
			});

			// Listen for submit messages from the textarea
			win.on("message", ((data: Record<string, unknown>) => {
				if (data?.type === "submit" && typeof data.text === "string" && (data.text as string).trim()) {
					options.onSubmit?.((data.text as string).trim());
				}
			}) as () => void);

			win.on("error", () => {
				clearTimeout(timeout);
				openFallback(filePath);
				resolve({ method: "browser", path: filePath });
			});

			win.on("closed", () => {
				clearTimeout(timeout);
			});
		});
	} catch {
		openFallback(filePath);
		return { method: "browser", path: filePath };
	}
}

function openFallback(filePath: string): void {
	const cmd = process.platform === "darwin" ? "open" : "xdg-open";
	exec(`${cmd} "${filePath}"`, (err) => {
		if (err) {
			console.error(`Could not open browser. File saved at: ${filePath}`);
		}
	});
}
