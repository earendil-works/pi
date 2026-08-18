/**
 * Inter-extension event bus example.
 *
 * Shows pi.events for communication between extensions. One extension
 * can emit events that other extensions listen to.
 *
 * Usage: /emit [event-name] [data] - emit an event on the bus
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Store ctx for use in event handler
	let currentCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	// Listen for events from other extensions
	pi.events.on("my:notification", (data) => {
		const { message, from } = data as { message: string; from: string };
		currentCtx?.ui.notify(`Event from ${from}: ${message}`, "info");
	});

	// Command to emit events (emits "my:notification" which the listener above receives)
	pi.registerCommand("emit", {
		description: "Emit my:notification event (usage: /emit message)",
		handler: async (args, _ctx) => {
			const message = args.trim() || "hello";
			pi.events.emit("my:notification", { message, from: "/emit command" });
			// Listener above will show the notification
		},
	});

	// Example: emit on session start
	pi.on("session_start", async () => {
		pi.events.emit("my:notification", {
			message: "Session started",
			from: "event-bus-example",
		});
	});
}
