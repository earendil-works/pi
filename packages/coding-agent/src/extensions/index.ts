import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [{ name: "llama.cpp", factory: llamaExtension, hidden: true }];
