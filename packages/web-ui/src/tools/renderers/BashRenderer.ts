import type { ToolResultMessage } from "@tculpepp/pi-ai";
import { html } from "lit";
import { SquareTerminal } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BashParams {
	command: string;
}

// Bash tool has undefined details (only uses output)
export class BashRenderer implements ToolRenderer<BashParams, undefined> {
	render(params: BashParams | undefined, result: ToolResultMessage<undefined> | undefined): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		// With result: show command + output
		if (result && params?.command) {
			const output =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			const combined = output ? `> ${params.command}\n\n${output}` : `> ${params.command}`;
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, SquareTerminal, i18n("Running command..."))}
						<console-block .content=${combined} .variant=${result.isError ? "error" : "default"}></console-block>
					</div>
				`,
				isCustom: false,
			};
		}

		// Just params (streaming or waiting)
		if (params?.command) {
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, SquareTerminal, i18n("Running command..."))}
						<console-block .content=${`> ${params.command}`}></console-block>
					</div>
				`,
				isCustom: false,
			};
		}

		// No params yet
		return { content: renderHeader(state, SquareTerminal, i18n("Waiting for command...")), isCustom: false };
	}
}
