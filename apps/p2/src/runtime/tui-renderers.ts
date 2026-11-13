// Rendering contributions (p2-tui-port.md section 7.2). Ordered registries use numeric key prefixes
// (`<order>:<plugin>`), applied in key order.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Component } from "@earendil-works/pi-tui";
import type { RenderContext } from "../tui/render-context.ts";
import type { ThemeRef } from "../tui/theme/ref.ts";
import type { Theme } from "../tui/theme/theme.ts";
import type { ToolRendererResolver, ToolRenderers } from "../tui/tools/types.ts";
import { keyedRegistry } from "./chord.ts";
import type { TuiSettings } from "./tui-preferences.ts";

export type { ToolRenderContext, ToolRendererResolver, ToolRenderers } from "../tui/tools/types.ts";

/** Tool renderers by tool name, from the plugins that own the tools; a tool without any gets pi's generic card. */
export const TuiToolRenderers = keyedRegistry<ToolRenderers>("p2.tui-tool-renderers");
/** `ToolRendererResolver`s with `next()`, run in key order before `TuiToolRenderers`. */
export const TuiToolRendererResolvers = keyedRegistry<ToolRendererResolver>("p2.tui-tool-renderer-resolvers");

export type EntryRenderContext = RenderContext & { readonly expanded: boolean };
/**
 * Components for committed entries by entry kind. A registered kind replaces the transcript's own display of the
 * entry (people's messages, notices); `undefined` hides it. Entry data is server data: sanitize text you show.
 */
export type TuiEntryRenderer = (entry: EntryRecord, ctx: EntryRenderContext) => Component | undefined;
export const TuiEntryRenderers = keyedRegistry<TuiEntryRenderer>("p2.tui-entry-renderers");

/**
 * pi's `MarkdownTransformContext`. p2 adds the instance theme and the visitor's settings: pi's transformers close over
 * its global theme and settings manager, p2's are registry entries shared by every instance (section 5.4).
 */
export type MarkdownTransformContext = {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
	theme: Theme;
	settings: TuiSettings | undefined;
};
/** pi's `MarkdownTransformer`: rewrites Markdown source before rendering; errors keep the current text. */
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;
export const TuiMarkdownTransformers = keyedRegistry<MarkdownTransformer>("p2.tui-markdown-transformers");

/** Values of an ordered registry table, in key order. */
export function ordered<V>(table: ReadonlyMap<string, V>): V[] {
	return [...table].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([, value]) => value);
}

/** coding-agent markdown-transform.ts. */
export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
	source: { readonly theme: ThemeRef; readonly settings?: TuiSettings },
): ((markdown: string, availableWidth: number) => string) | undefined {
	if (transformers.length === 0) return undefined;
	return (markdown, availableWidth) => {
		let result = markdown;
		for (const transformer of transformers) {
			try {
				const transformed = transformer(result, {
					messageType,
					isStreaming,
					availableWidth,
					theme: source.theme.current,
					settings: source.settings,
				});
				if (typeof transformed === "string") result = transformed;
			} catch {}
		}
		return result;
	};
}
