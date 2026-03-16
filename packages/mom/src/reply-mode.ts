import type { SlackEvent } from "./slack.js";

export function getThreadParentTs(event: Pick<SlackEvent, "type" | "ts">, isEvent?: boolean): string | null {
	return event.type === "mention" && !isEvent ? event.ts : null;
}
