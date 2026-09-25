// Vim modal editing for pi-plus: hidden built-in extension. The "vim" setting in
// settings.json controls the startup default; /vim toggles it and persists the new
// state to the agent dir settings.json so it sticks across launches.
// Re-applied on every session_start because interactive-mode resets custom editors when
// sessions switch/reload (resetExtensionUI), always followed by a fresh session_start.

import type {
	EditorFactory,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../../../../coding-agent/src/core/extensions/types.ts";
import { readVimEnabled, writeVimEnabled } from "./settings.ts";
import { VimEditor } from "./vim-editor.ts";

const factory: EditorFactory = (tui, theme, keybindings) => new VimEditor(tui, theme, keybindings);

/** In-process override so /vim takes effect immediately, before the settings write is re-read. */
let sessionOverride: boolean | undefined;

function apply(ctx: ExtensionContext, enabled: boolean): void {
	ctx.ui.setEditorComponent(enabled ? factory : undefined);
}

export function registerVim(pi: ExtensionAPI): void {
	pi.registerCommand("vim", {
		description: "Toggle vim modal editing (persists across launches)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const enabled = !(sessionOverride ?? readVimEnabled(ctx.cwd));
			sessionOverride = enabled;
			apply(ctx, enabled);
			if (!writeVimEnabled(enabled)) {
				ctx.ui.notify("Vim mode enabled (session only — could not write settings.json)", "warning");
				return;
			}
			ctx.ui.notify(enabled ? "Vim mode enabled" : "Vim mode disabled", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (sessionOverride ?? readVimEnabled(ctx.cwd)) apply(ctx, true);
	});
}
