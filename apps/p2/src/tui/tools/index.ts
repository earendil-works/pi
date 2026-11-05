// Built-in tool renderers by tool name (coding-agent core/tools/renderers/index.ts), plus code mode's.
import type { TuiSettings } from "../../runtime/tui-preferences.ts";
import { codemodeRenderers } from "./codemode.ts";
import { editRenderers, findRenderers, grepRenderers, lsRenderers, readRenderers, writeRenderers } from "./files.ts";
import { createShellRenderers } from "./shell.ts";
import type { ToolRendererResolver, ToolRenderers } from "./types.ts";

export const BUILTIN_TOOL_RENDERERS: Readonly<Record<string, ToolRenderers>> = {
	read: readRenderers,
	bash: createShellRenderers("$"),
	powershell: createShellRenderers("PS>"),
	edit: editRenderers,
	write: writeRenderers,
	grep: grepRenderers,
	find: findRenderers,
	ls: lsRenderers,
	codemode: codemodeRenderers,
};

/**
 * Section 7.2: ordered resolvers (by key), then the per-name registry, then the built-ins; undefined means the generic
 * card.
 */
export function resolveToolRenderers(
	name: string,
	resolvers: ReadonlyMap<string, ToolRendererResolver>,
	registered: ReadonlyMap<string, ToolRenderers>,
	settings: TuiSettings,
): ToolRenderers | undefined {
	const ordered = [...resolvers].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([, r]) => r);
	const at = (index: number): ToolRenderers | undefined => {
		const resolver = ordered[index];
		if (!resolver) return registered.get(name) ?? BUILTIN_TOOL_RENDERERS[name];
		try {
			return resolver(name, () => at(index + 1), settings);
		} catch {
			return at(index + 1);
		}
	};
	return at(0);
}
