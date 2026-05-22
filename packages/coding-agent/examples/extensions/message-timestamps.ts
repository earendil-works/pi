/**
 * Message timestamps extension
 *
 * Add timestamps to all messages and tool calls in the message view.
 *
 * This extension demonstrates how to use message decorators to modify existing components.
 */

import type {
	ExtensionAPI,
	MessageDecorationSubject,
	MessageDecoratorDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";

function formatTimestamp(ts: number): string {
	return new Date(ts).toTimeString().slice(0, 8);
}

function getTimestamp(subject: MessageDecorationSubject): string {
	const ts = subject.type === "message" ? subject.message.timestamp : subject.timestamp;
	return ts ? formatTimestamp(ts) : "";
}

function isBox(component: Component): component is Box {
	return component instanceof Box;
}

export default function addMessageTimestamps(pi: ExtensionAPI): void {
	const definition: MessageDecoratorDefinition = {
		roles: "*",
		priority: 10,
		decorate(subject, context) {
			const ts = getTimestamp(subject);
			if (!ts) return;

			const label = context.theme.fg("muted", `[${ts}]`);
			const timestamp = new Text(label, 0, 0);
			const box = context.findDescendant(context.components, isBox);
			if (box && context.insertChild(box, timestamp, 0)) {
				return;
			}

			context.insertChild(context.parent, timestamp, 0);
		},
	};

	pi.registerMessageDecorator("pi-message-timestamps.time", definition);
}
