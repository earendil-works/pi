import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function widgetPlacementExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
		ctx.ui.setWidget("widget-border-tl", ["top-left"], { placement: "borderTopLeft" });
		ctx.ui.setWidget("widget-border-tr", ["top-right"], { placement: "borderTopRight" });
		ctx.ui.setWidget("widget-border-bl", ["bottom-left"], { placement: "borderBottomLeft" });
		ctx.ui.setWidget("widget-border-br", ["bottom-right"], { placement: "borderBottomRight" });
	});
}
