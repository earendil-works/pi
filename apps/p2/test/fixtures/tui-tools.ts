// The TUI cards of p2's plugins' tools, by tool name, as their TUI facets register them (`TuiToolRenderers`), for tests
// that draw a transcript without a runtime (`transcriptComponent(..., { renderers })`).
import { codemodeRenderers } from "../../plugins/codemode/tui.ts";
import { codingToolRenderers } from "../../plugins/coding-tools/tui.ts";
import { powershellRenderers } from "../../plugins/powershell/tui.ts";
import type { ToolRenderers } from "../../src/tui/tools/types.ts";

export const PLUGIN_TUI_RENDERERS: ReadonlyMap<string, ToolRenderers> = new Map(
	Object.entries({ ...codingToolRenderers, powershell: powershellRenderers, codemode: codemodeRenderers }),
);
