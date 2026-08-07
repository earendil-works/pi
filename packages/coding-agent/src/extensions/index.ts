import type { InlineExtension } from "../core/extensions/types.ts";
import cursorAgentExtension from "./cursor-agent/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "cursor-agent", factory: cursorAgentExtension, hidden: true },
];
