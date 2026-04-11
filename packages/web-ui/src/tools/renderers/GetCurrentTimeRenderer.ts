import type { ToolResultMessage } from "@tculpepp/spi-ai";
import { html } from "lit";
import { Clock } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface GetCurrentTimeParams {
	timezone?: string;
}

// GetCurrentTime tool has undefined details (only uses output)
export class GetCurrentTimeRenderer implements ToolRenderer<GetCurrentTimeParams, undefined> {
	render(
		params: GetCurrentTimeParams | undefined,
		result: ToolResultMessage<undefined> | undefined,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		// Full params + full result
		if (result && params) {
			const output =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			const headerText = params.timezone
				? `${i18n("Getting current time in")} ${params.timezone}`
				: i18n("Getting current date and time");

			// Error: show header, error below
			if (result.isError) {
				return {
					content: html`
						<div class="space-y-3">
							${renderHeader(state, Clock, headerText)}
							<div class="text-sm text-destructive">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Success: show time in header
			return { content: renderHeader(state, Clock, `${headerText}: ${output}`), isCustom: false };
		}

		// Full result, no params
		if (result) {
			const output =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";

			// Error: show header, error below
			if (result.isError) {
				return {
					content: html`
						<div class="space-y-3">
							${renderHeader(state, Clock, i18n("Getting current date and time"))}
							<div class="text-sm text-destructive">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Success: show time in header
			return {
				content: renderHeader(state, Clock, `${i18n("Getting current date and time")}: ${output}`),
				isCustom: false,
			};
		}

		// Full params, no result: show timezone info in header
		if (params?.timezone) {
			return {
				content: renderHeader(state, Clock, `${i18n("Getting current time in")} ${params.timezone}`),
				isCustom: false,
			};
		}

		// Partial params (no timezone) or empty params, no result
		if (params) {
			return { content: renderHeader(state, Clock, i18n("Getting current date and time")), isCustom: false };
		}

		// No params, no result
		return { content: renderHeader(state, Clock, i18n("Getting time...")), isCustom: false };
	}
}
