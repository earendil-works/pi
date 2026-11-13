// pi's tool renderer contract (coding-agent core/extensions/types.ts `ToolRenderers`, `ToolRenderContext`,
// `ToolRendererResolver`), typed for p2: arguments and details are JSON from the conversation view, the theme is the
// instance theme (section 5), and the calls a call made to other tools come with the context.
import type { JsonValue } from "@earendil-works/chord/json";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { TuiSettings } from "../../runtime/tui-preferences.ts";
import type { NestedCall, ToolView } from "../../web/transcript.ts";
import type { RenderContext } from "../render-context.ts";
import type { Theme } from "../theme/theme.ts";

export type ToolArgs = Record<string, unknown>;
export type ToolResultView = { content: (TextContent | ImageContent)[]; details: JsonValue | undefined };
export type ToolRenderResultOptions = { expanded: boolean; isPartial: boolean };

export interface ToolRenderContext {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	args: ToolArgs;
	/** Stable across call/result renders for the same tool call. */
	toolCallId: string;
	/** Invalidate just this tool card and redraw. */
	invalidate(): void;
	/** Previously returned component for this render slot, if any. */
	lastComponent: Component | undefined;
	/** Renderer state for this card. */
	state: Record<string, unknown>;
	/** The session's working directory, for relative path display. */
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	/** Inline images are never drawn by the worker (section 1.4): always false. */
	showImages: boolean;
	isError: boolean;
	/** The final result's execution time. */
	durationMs: number | undefined;
	outputPad: number;
	/**
	 * p2: calls this call made to other tools (a script's), live or settled: as the tool's `nestedCalls` reads them, else
	 * as Durable shows them.
	 */
	calls: readonly NestedCall[] | undefined;
	/** p2: theme reference and key hints. */
	ui: RenderContext;
}

export interface ToolRenderers {
	renderShell?: "default" | "self";
	/**
	 * p2: the calls this call made to other tools, when the tool keeps their final list in its result's `details` (read
	 * from there once settled; `tool.calls` holds the ones Durable shows, live or last seen). Without it, `tool.calls`.
	 * Resolvers do not change it (`resolveToolRenderers`).
	 */
	nestedCalls?: (tool: ToolView) => readonly NestedCall[] | undefined;
	renderCall?: (args: ToolArgs, theme: Theme, context: ToolRenderContext) => Component;
	renderResult?: (
		result: ToolResultView,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext,
	) => Component;
}

/**
 * Chooses how calls to a tool are drawn; `next()` returns what the remaining resolvers, then the registry, would use.
 * p2: `settings` are the visitor's; when they change, every card is drawn again with a new resolution.
 */
export type ToolRendererResolver = (
	toolName: string,
	next: () => ToolRenderers | undefined,
	settings: TuiSettings,
) => ToolRenderers | undefined;

/** A JSON object, or undefined. */
export function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
