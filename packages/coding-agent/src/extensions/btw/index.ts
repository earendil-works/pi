// Built-in temporary read-only side conversations, displayed through the shared pane host.

import type { ExtensionCommandContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { parsePaneCommand } from "../../core/panes/command.ts";
import { openPane, type PaneHandle, type PaneOptions } from "../../core/panes/host.ts";
import { SideChatView } from "../../core/panes/side-chat.ts";
import { createSideSession } from "../../core/side-session.ts";
import { icon } from "../../modes/interactive/icons.ts";

type SidePane = { pane: PaneHandle; view: SideChatView };

/** Register /btw without creating a saved session or modifying the main conversation. */
export function createBtwExtension(): ExtensionFactory {
	return (pi) => {
		let lifetime = new AbortController();
		let active: SidePane | undefined;
		let opening: Promise<SidePane> | undefined;
		async function create(
			ctx: ExtensionCommandContext,
			options: Pick<PaneOptions, "backend" | "placement" | "minimized">,
			question: string,
		): Promise<SidePane> {
			// openPane resolves only after it has called the factory exactly once.
			let view!: SideChatView;
			const pane = await openPane(ctx, {
				...options,
				title: `${icon("chat")} btw — temporary read-only conversation`,
				signal: lifetime.signal,
				create: (controls) => {
					view = new SideChatView(createSideSession(ctx), controls, question);
					return view;
				},
			});
			const result = { pane, view };
			active = result;
			void pane.closed.then(() => {
				if (active === result) active = undefined;
			});
			return result;
		}
		pi.registerCommand("btw", {
			description:
				"Ask in a temporary read-only side conversation: /btw [--tui|--rex] [--split|--floating] [question]",
			handler: async (args, ctx) => {
				if (args.trim() === "--help") {
					ctx.ui.notify(
						"/btw [--tui|--rex] [--split|--floating] [--minimized] [question]. Starts from a snapshot of this conversation with read, grep, find and ls only. Follow-ups stay in the side view. Escape cancels an answer, then closes when idle; /close discards it. Calling /btw again restores the open side chat. Nothing is saved in pi's session history.",
						"info",
					);
					return;
				}
				const { options, text } = parsePaneCommand(args);
				const existing = active ?? (opening ? await opening : undefined);
				if (existing) {
					if (options.backend && options.backend !== "auto" && options.backend !== existing.pane.backend)
						throw new Error("Close the current side chat before changing its presentation backend");
					if (
						options.placement &&
						existing.pane.backend === "rex" &&
						options.placement !== existing.pane.placement
					)
						throw new Error("Close the current side chat before changing its Rex placement");
					await existing.pane.show();
					if (text) existing.view.ask(text);
					return;
				}
				opening = create(ctx, options, text);
				try {
					await opening;
				} finally {
					opening = undefined;
				}
			},
		});
		pi.on("session_start", () => {
			if (lifetime.signal.aborted) lifetime = new AbortController();
		});
		pi.on("session_shutdown", async () => {
			lifetime.abort();
			if (opening) await opening.catch(() => undefined);
			await active?.pane.close();
			active = undefined;
		});
	};
}

export default createBtwExtension();
