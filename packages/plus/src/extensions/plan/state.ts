/**
 * Per-session plan mode state plus the footer status helper.
 *
 * State lives for the lifetime of the extension runtime: it survives
 * `/reload` (the runtime is reused) and is reset on session replacement
 * (`new`/`resume`/`fork`) in the session_start handler.
 */

import type { ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";

export interface PlanModeState {
	enabled: boolean;
	planFilePath: string | undefined;
}

export function createPlanState(): PlanModeState {
	return { enabled: false, planFilePath: undefined };
}

/** Footer indicator: "⏸ plan" while active, cleared otherwise. */
export function updateStatus(ctx: ExtensionContext, state: PlanModeState): void {
	ctx.ui.setStatus("plan", state.enabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
}
