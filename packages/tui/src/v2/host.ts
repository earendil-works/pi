import { TUI } from "../tui.ts";

/** Terminal renderer selection. `v1` is the differential whole-tree renderer; `v2` is the Ledger+Band host. */
export type TuiRenderMode = "v1" | "v2";

/**
 * v2 Ledger+Band terminal host.
 *
 * Subclasses the concrete {@link TUI} class so extension factory callbacks that receive a `TUI`
 * (setWidget/setFooter/setHeader/custom/setEditorComponent) keep working unchanged (plan §7). The
 * v2 render pipeline (Ledger frontier, Band layout, Presenter commits) is layered on top of the
 * inherited overlay/focus/input machinery in later Phase-B steps rather than by branching v1's
 * whole-tree `render(width)` / `doRender()` path (plan §1).
 */
export class V2TUIHost extends TUI {
	readonly renderMode: TuiRenderMode = "v2";
}
