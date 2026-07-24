import type { InlineExtension } from "../core/extensions/types.ts";
import ansteelTeamExtension from "./ansteel-team/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "ansteel-team", factory: ansteelTeamExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
