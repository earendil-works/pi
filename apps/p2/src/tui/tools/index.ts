// How a tool call is drawn: plugins register their tools' renderers (`TuiToolRenderers`, by tool name) and resolvers
// (`TuiToolRendererResolvers`, wrapping all of them); a tool without any gets pi's generic card.
import type { TuiSettings } from "../../runtime/tui-preferences.ts";
import type { ToolRendererResolver, ToolRenderers } from "./types.ts";

/**
 * Section 7.2: ordered resolvers (by key), then the per-name registry; undefined means the generic card. The registry's
 * `nestedCalls` is the tool's own data, not drawing: it stays whatever resolvers draw the card with.
 */
export function resolveToolRenderers(
	name: string,
	resolvers: ReadonlyMap<string, ToolRendererResolver>,
	registered: ReadonlyMap<string, ToolRenderers>,
	settings: TuiSettings,
): ToolRenderers | undefined {
	const ordered = [...resolvers].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([, r]) => r);
	const own = registered.get(name);
	const at = (index: number): ToolRenderers | undefined => {
		const resolver = ordered[index];
		if (!resolver) return own;
		try {
			return resolver(name, () => at(index + 1), settings);
		} catch {
			return at(index + 1);
		}
	};
	const drawn = at(0);
	const nestedCalls = own?.nestedCalls;
	if (!nestedCalls || drawn?.nestedCalls === nestedCalls) return drawn;
	return { ...drawn, nestedCalls };
}
