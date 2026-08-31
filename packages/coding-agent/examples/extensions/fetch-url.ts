/**
 * Fetch URL Extension
 *
 * Demonstrates a custom LLM-callable tool with:
 * - `defineTool` for parameter type inference
 * - `promptSnippet` / `promptGuidelines` system-prompt contributions
 * - Custom `renderCall` / `renderResult` TUI rendering
 * - A CLI flag (`--fetch-timeout`) and a `/fetch-url` command
 *
 * The tool uses Node's global `fetch`, so it has zero extra dependencies.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/fetch-url.ts
 *   # Then ask the agent to fetch a URL, e.g. "fetch https://example.com"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const FetchUrlParams = Type.Object({
	url: Type.String({ description: "The URL to fetch" }),
	maxBytes: Type.Optional(Type.Number({ description: "Maximum response bytes to return (default 8000)" })),
});

interface FetchUrlDetails {
	url: string;
	status: number;
	bytes: number;
	truncated: boolean;
}

/** Default timeout in milliseconds; overridable via the --fetch-timeout flag. */
let fetchTimeoutMs = 15_000;

export default function (pi: ExtensionAPI) {
	pi.registerFlag("fetch-timeout", {
		description: "Timeout in seconds for the fetch_url tool (default 15)",
		type: "string",
		default: "15",
	});

	pi.registerTool(
		defineTool({
			name: "fetch_url",
			label: "Fetch URL",
			description: "Fetch a URL and return its text content. Use for reading web pages or API responses.",
			promptSnippet: "Fetch a URL and return its text content",
			promptGuidelines: ["Prefer fetch_url over bash curl for simple HTTP GET requests."],
			parameters: FetchUrlParams,

			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				const maxBytes = params.maxBytes ?? 8000;
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
				const onAbort = () => controller.abort();
				signal?.addEventListener("abort", onAbort, { once: true });

				try {
					const response = await fetch(params.url, { signal: controller.signal, redirect: "follow" });
					const body = await response.text();
					const truncated = body.length > maxBytes;
					const content = truncated ? `${body.slice(0, maxBytes)}\n\n[truncated at ${maxBytes} bytes]` : body;
					return {
						content: [
							{
								type: "text",
								text: response.ok ? content : `HTTP ${response.status}: ${content}`,
							},
						],
						details: {
							url: params.url,
							status: response.status,
							bytes: body.length,
							truncated,
						} as FetchUrlDetails,
					};
				} finally {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
				}
			},

			renderCall(args, theme, _context) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", args.url), 0, 0);
			},

			renderResult(result, _options, theme, context) {
				const details = result.details as FetchUrlDetails | undefined;
				if (context.isError || !details) {
					return new Text(theme.fg("error", "fetch failed"), 0, 0);
				}
				const status =
					details.status < 400 ? theme.fg("success", `${details.status}`) : theme.fg("error", `${details.status}`);
				const size = details.truncated
					? theme.fg("warning", `${details.bytes} bytes (truncated)`)
					: theme.fg("muted", `${details.bytes} bytes`);
				return new Text(`${theme.fg("muted", "✓")} ${status} ${theme.fg("dim", details.url)} ${size}`, 0, 0);
			},
		}),
	);

	// Apply the flag on session start (flags are resolved after extension load).
	pi.on("session_start", () => {
		const raw = pi.getFlag("fetch-timeout");
		const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : undefined;
		fetchTimeoutMs = parsed && parsed > 0 ? parsed * 1000 : 15_000;
	});

	pi.registerCommand("fetch-url", {
		description: "Show the current fetch_url timeout",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`fetch_url timeout is ${fetchTimeoutMs / 1000}s`, "info");
		},
	});
}
