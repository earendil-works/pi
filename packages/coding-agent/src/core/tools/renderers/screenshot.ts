/**
 * Presentation for the screenshot tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `screenshot.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import { getTextOutput, renderToolPath, str } from "../render-utils.ts";

function formatShotCall(args: { path?: string } | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "screen" });
	return `${theme.fg("toolTitle", theme.bold("screenshot"))} ${pathDisplay}`;
}

export const screenshotRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatShotCall(args as { path?: string } | undefined, theme, context.cwd));
		return text;
	},
	renderResult(result, _options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const output = getTextOutput(result as never, context.showImages).trim();
		text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
		return text;
	},
};
