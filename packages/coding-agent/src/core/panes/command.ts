// Shared leading presentation flags for pi commands that open a pane.
import type { PaneOptions } from "./host.ts";

/** Parse presentation flags without interpreting or rewriting the remaining question or job ID. */
export function parsePaneCommand(input: string): {
	options: Pick<PaneOptions, "backend" | "placement" | "minimized">;
	text: string;
} {
	const options: Pick<PaneOptions, "backend" | "placement" | "minimized"> = {};
	let text = input.trim();
	while (text.startsWith("--")) {
		if (text === "--") {
			text = "";
			break;
		}
		if (text.startsWith("-- ")) {
			text = text.slice(3);
			break;
		}
		const match = /^(--\S+)(?:\s+|$)/.exec(text);
		if (!match) break;
		switch (match[1]) {
			case "--tui":
				options.backend = "tui";
				break;
			case "--rex":
				options.backend = "rex";
				break;
			case "--split":
				options.placement = "split";
				break;
			case "--floating":
				options.placement = "floating";
				break;
			case "--minimized":
				options.minimized = true;
				break;
			default:
				throw new Error(`Unknown pane option ${match[1]}; use --tui, --rex, --split, --floating or --minimized`);
		}
		text = text.slice(match[0].length);
	}
	if (options.minimized && options.placement === "split")
		throw new Error("Minimized panes require --floating, not --split");
	return { options, text };
}
