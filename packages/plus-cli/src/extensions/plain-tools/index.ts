/**
 * pi-plus-plain-tools: strip the background fills from tool result blocks.
 *
 * Upstream paints every tool block with theme backgrounds — pending
 * (toolPendingBg) while running, green (toolSuccessBg) / red (toolErrorBg) on
 * completion (ToolExecutionComponent, the bash/read renderers, and the edit
 * diff boxes). pi-plus conveys status with words and spinners instead, so
 * those fills are removed and the blocks render as plain text.
 *
 * Implemented as a Theme.prototype.bg wrapper rather than a custom theme JSON
 * so it applies to every theme (built-in and custom) and survives /theme
 * switches; only the three tool-block tokens are affected, all other
 * background tokens (selections, user message bubble, ...) pass through.
 */

import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { Theme, type ThemeBg } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";

const PLAIN_TOOL_BG_TOKENS: readonly ThemeBg[] = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];

let patched = false;

export function stripToolBlockBackgrounds(): void {
	if (patched) return;
	patched = true;
	const originalBg = Theme.prototype.bg;
	Theme.prototype.bg = function (color: ThemeBg, text: string): string {
		if (PLAIN_TOOL_BG_TOKENS.includes(color)) return text;
		return originalBg.call(this, color, text);
	};
}

export function registerPlainTools(_pi: ExtensionAPI): void {
	stripToolBlockBackgrounds();
}
