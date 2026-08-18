/**
 * Send User Message Example
 *
 * Demonstrates pi.sendUserMessage() for sending user messages from extensions.
 * Unlike pi.sendMessage() which sends custom messages, sendUserMessage() sends
 * actual user messages that appear in the conversation as if typed by the user.
 *
 * Usage:
 *   /ask What is 2+2?     - Sends a user message (always triggers a turn)
 *   /steer Focus on X     - Sends while streaming with steer delivery
 *   /followup And then?   - Sends while streaming with followUp delivery
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Simple command that sends a user message
	pi.registerCommand("ask", {
		description: "Send a user message to the agent",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /ask <message>", "warning");
				return;
			}

			// sendUserMessage always triggers a turn when not streaming
			// If streaming, it will throw (no deliverAs specified)
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Use /steer or /followup instead.", "warning");
				return;
			}

			pi.sendUserMessage(args);
		},
	});

	// Command that steers the agent mid-conversation
	pi.registerCommand("steer", {
		description: "Send a steering message (interrupts current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /steer <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// Not streaming, just send normally
				pi.sendUserMessage(args);
			} else {
				// Streaming - use steer to interrupt
				pi.sendUserMessage(args, { deliverAs: "steer" });
			}
		},
	});

	// Command that queues a follow-up message
	pi.registerCommand("followup", {
		description: "Queue a follow-up message (waits for current processing)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /followup <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// Not streaming, just send normally
				pi.sendUserMessage(args);
			} else {
				// Streaming - queue as follow-up
				pi.sendUserMessage(args, { deliverAs: "followUp" });
				ctx.ui.notify("Follow-up queued", "info");
			}
		},
	});

	// Example with content array (text + images would go here)
	pi.registerCommand("askwith", {
		description: "Send a user message with structured content",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /askwith <message>", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			// sendUserMessage accepts string or (TextContent | ImageContent)[]
			pi.sendUserMessage([
				{ type: "text", text: `User request: ${args}` },
				{ type: "text", text: "Please respond concisely." },
			]);
		},
	});
}
