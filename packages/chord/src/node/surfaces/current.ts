// The scripts objects a surface serves (slice 11 §1, decision "Slice 11, P5"): on the server, one local object per
// surface holds the published set (a writable, set by each publish), and the surface's scripts object (`WebScripts`,
// `TuiScripts`), made per principal, shows it. A rollout publishes without waiting for clients: each client's hold gets
// one frame, and a reconnect's snapshot brings the set it missed.

import type { Context } from "../../context/index.ts";
import { local, method } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet, type Host } from "../../host/index.ts";
import { ScriptSet, type ScriptsContract, TuiScripts, WebScripts } from "../../surfaces/index.ts";

/** A surface: the web (pages) or the terminal. */
export type SurfaceName = "web" | "tui";

/** The local object holding a surface's published set, by surface. */
const CURRENT = {
	web: currentContract("chord.web.current"),
	tui: currentContract("chord.tui.current"),
};

/** The scripts object each surface serves. */
const SCRIPTS: Readonly<Record<SurfaceName, ScriptsContract>> = { web: WebScripts, tui: TuiScripts };

/** The contract of a surface's published set: its `set` and `publish`. */
function currentContract<const N extends string>(name: N) {
	return local(name, { version: 1, params: {}, members: { set: ScriptSet, publish: method(ScriptSet) } });
}

/**
 * The surface's facet serving its published set (starting at `published.set` when first held: the surface's first set,
 * or an empty one before its build, which publishes the first) and its scripts object for every principal that may hold
 * it.
 */
export function scriptsFacet<P extends Principal>(
	surface: SurfaceName,
	published: { readonly set: ScriptSet },
): Facet<P> {
	const Current = CURRENT[surface];
	return defineFacet<P>((host) => {
		host.serve(Current, (_params, self) => {
			// The latest set: an attempt after a failure starts at what was published last.
			const set = self.writable<ScriptSet>(published.set);
			return {
				set: self.derive([set], ([value]) => value),
				publish: async (next) => {
					set.set(next);
					return null;
				},
			};
		});
		host.serve(SCRIPTS[surface], (_params, _principal, self) => {
			const current = self.get(Current, {});
			return { variant: "main", members: { set: self.derive([current.set], ([value]) => value) } };
		});
	});
}

/** Publishes `set` as `surface`'s current set on `host` (loaded with `scriptsFacet`). */
export async function publishTo<P extends Principal>(
	host: Host<P>,
	surface: SurfaceName,
	set: ScriptSet,
	context: Context,
): Promise<void> {
	const current = await host.get(CURRENT[surface], {}, context);
	try {
		await current.publish(set, context);
	} finally {
		current.release();
	}
}
