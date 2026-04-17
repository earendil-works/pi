import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let last = "No click yet";

		ctx.ui.setWidget("widget-mouse-demo", (_tui, theme) => ({
			focused: false,
			render(width: number) {
				const title = this.focused
					? theme.fg("accent", "Widget mouse demo [focused]")
					: theme.fg("text", "Widget mouse demo");
				return [title, `Last: ${last}`, theme.fg("dim", "Click here or type while focused")].map((line) =>
					truncateToWidth(line, width),
				);
			},
			handleMouse(event) {
				last = `click row=${event.row} col=${event.col}`;
			},
			handleInput(data: string) {
				last = `key ${JSON.stringify(data)}`;
			},
			invalidate() {},
		}));
	});
}
