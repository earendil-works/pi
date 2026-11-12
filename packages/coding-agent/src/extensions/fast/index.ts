// Controls Codex priority-tier requests without replacing the native footer.
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

/** Registers session-persisted /fast controls for ChatGPT/Codex models. */
export default function fastExtension(pi: ExtensionAPI): void {
	let enabled = false;
	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("fast", enabled ? (supportsFast(ctx) ? "fast (priority)" : "fast (inactive)") : undefined);
	};
	const restore = (ctx: ExtensionContext) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "chatgpt-fast-mode") continue;
			// Saved custom-entry JSON includes state written by the former local extension.
			const data = entry.data;
			enabled = data !== null && typeof data === "object" && "enabled" in data && data.enabled === true;
		}
		updateStatus(ctx);
	};
	pi.registerCommand("fast", {
		description: "Toggle Codex priority tier (higher usage): /fast [on|off|status]",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "" && action !== "on" && action !== "off" && action !== "status") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(
					`Codex fast mode: ${enabled ? "on" : "off"}${enabled && !supportsFast(ctx) ? " (inactive on this provider)" : ""}`,
					"info",
				);
				return;
			}
			const next = action === "" ? !enabled : action === "on";
			if (next && !supportsFast(ctx)) {
				ctx.ui.notify("Fast mode requires a ChatGPT/Codex model (openai-codex).", "warning");
				return;
			}
			if (next !== enabled) pi.appendEntry("chatgpt-fast-mode", { enabled: next });
			enabled = next;
			updateStatus(ctx);
			ctx.ui.notify(
				next
					? "Codex fast mode: on (priority tier; higher usage). Applies to the next request."
					: "Codex fast mode: off. Applies to the next request.",
				"info",
			);
		},
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !supportsFast(ctx)) return;
		// Provider request payloads are a wire boundary; do not silently claim priority on a malformed payload.
		if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
			throw new Error("Codex fast mode requires an object request payload");
		}
		return { ...event.payload, service_tier: "priority" };
	});
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
}

function supportsFast(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}
