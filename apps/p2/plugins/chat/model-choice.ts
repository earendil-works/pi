// What the chat's screens and its command menu pages share about models: the new-session screen's model, and thinking
// levels as stored.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { isThinkingLevel } from "@p2/app/v1";
import type { ModelChoice } from "@p2/app/v1/web";
import type { ResourceSnapshot } from "../models/contract.ts";
import type { Session } from "../sessions/contract.ts";

/** The new-session screen's model: as chosen there, else the default for new sessions, else the latest session's. */
export function newSessionChoice(
	selected: ModelChoice | undefined,
	resources: ResourceSnapshot | undefined,
	latest: Session | undefined,
): ModelChoice | undefined {
	if (selected) return selected;
	const model = resources?.settings.defaultModel ?? latest?.model;
	return model && { model, thinkingLevel: resources?.settings.thinkingLevel ?? "high" };
}

/** A thinking level as stored (catalog rows and subagents keep text); anything unknown is off. */
export const thinkingLevelOf = (level: string): ModelThinkingLevel => (isThinkingLevel(level) ? level : "off");
