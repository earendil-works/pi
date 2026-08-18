/**
 * Hidden Thinking Label Extension
 *
 * Demonstrates `ctx.ui.setHiddenThinkingLabel()` for customizing the label shown
 * when thinking blocks are hidden.
 *
 * Usage:
 *   pi --extension examples/extensions/hidden-thinking-label.ts
 *
 * Test:
 *   1. Load this extension
 *   2. Hide thinking blocks with Ctrl+T
 *   3. Ask for something that produces reasoning output
 *   4. The collapsed thinking block label will show the custom text
 *
 * Commands:
 *   /thinking-label <text>   Set a custom hidden thinking label
 *   /thinking-label          Reset to the default label
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_LABEL = "Pondering...";

export default function (pi: ExtensionAPI) {
	let label = DEFAULT_LABEL;

	const applyLabel = (ctx: ExtensionContext) => {
		ctx.ui.setHiddenThinkingLabel(label);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyLabel(ctx);
	});

	pi.registerCommand("thinking-label", {
		description: "Set the hidden thinking label. Use without args to reset.",
		handler: async (args, ctx) => {
			const nextLabel = args.trim();

			if (!nextLabel) {
				label = DEFAULT_LABEL;
				ctx.ui.setHiddenThinkingLabel();
				ctx.ui.notify(`Hidden thinking label reset to: ${DEFAULT_LABEL}`);
				return;
			}

			label = nextLabel;
			ctx.ui.setHiddenThinkingLabel(label);
			ctx.ui.notify(`Hidden thinking label set to: ${label}`);
		},
	});
}
