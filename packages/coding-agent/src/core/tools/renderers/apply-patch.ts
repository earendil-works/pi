/**
 * Presentation for the apply_patch tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `apply-patch.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { getTextOutput, str } from "../render-utils.ts";

function formatCall(args: { patch?: string } | undefined, options: ToolRenderResultOptions, theme: Theme): string {
	let text = `${theme.fg("toolTitle", theme.bold("apply_patch"))}`;
	const patch = str(args?.patch);
	if (patch === null) {
		text += `\n\n${theme.fg("error", "[invalid patch arg - expected string]")}`;
	} else if (patch) {
		const lines = patch.split("\n");
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}
	return text;
}

export const applyPatchRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatCall(
				args as { patch?: string } | undefined,
				{ expanded: context.expanded, isPartial: context.isPartial },
				theme,
			),
		);
		return text;
	},
	renderResult(result, _options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const output = getTextOutput(result as never, context.showImages).trim();
		text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
		return text;
	},
};
