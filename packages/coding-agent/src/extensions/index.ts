import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import ollamaExtension from "./ollama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "ollama", factory: ollamaExtension, hidden: true },
];
