// What the things plugin's page parts share: every registered kind by name, a message of any plugin as text, how a
// "from" reads, what a party opens, how a party, a kind and a thing are named, and what a failed call or a denial says.

import { type MessageData, Translations } from "@earendil-works/p3/v1";
import { type Target, useHold, useLive, useMessages, useRegistry, useWatch } from "@earendil-works/p3/v1/web";
import { useMemo } from "react";
import type { Party } from "./contract.ts";
import { useMessageText } from "./contract.web.tsx";
import { type KindView, ThingKindsView } from "./kind.ts";
import { page } from "./page-messages.ts";
import type { Origin } from "./workspace.ts";

/** Every registered kind, by name (`undefined` until known). */
export function useKinds(): ReadonlyMap<string, KindView> | undefined {
	const kinds = useWatch(useLive(useHold(ThingKindsView, {}))?.kinds);
	return useMemo(() => (kinds === undefined ? undefined : new Map(Object.entries(kinds))), [kinds]);
}

/** How a row's "from" reads: nothing for here; else "from Family", or "from above" where the caller is not present. */
export function useFromText(): (from: Origin) => string | undefined {
	const { t } = useMessages(page);
	return (from) => {
		switch (from.kind) {
			case "here":
				return undefined;
			case "above":
				return t("fromNamed", from.name);
			case "aboveUnnamed":
				return t("fromUnnamed");
		}
	};
}

/** The target a party opens from `workspace`: a person's or a group's view; everyone and the agents open nothing. */
export function partyTarget(workspace: string, party: Party): Target | undefined {
	switch (party.kind) {
		case "person":
			return { kind: "person", workspace, person: party.person };
		case "group":
			return { kind: "group", workspace, group: party.group };
		default:
			return undefined;
	}
}

/** How the page names a party: its name, else (everyone here, the agents, one session's agent have none) its kind. */
export function usePartyName(): (party: Party, name: string) => string {
	const { t } = useMessages(page);
	return (party, name) => {
		if (name !== "") return name;
		switch (party.kind) {
			case "everyone":
				return t("everyoneHere");
			case "agents":
				return t("agents");
			case "agent":
				return t("agentOf", party.session.slice(0, 8));
			default:
				return name;
		}
	};
}

/** What a failed call says to the person: the message the server sent with it, else the error's own text. */
export function useErrorText(): (error: unknown) => string {
	const text = useMessageText();
	return (error) => {
		const message = messageOf(error);
		if (message !== undefined) return text(message);
		return error instanceof Error ? error.message : String(error);
	};
}

/**
 * The message the server sent with an error (`details.message`, as data: a denial's, a refused call's), if it sent
 * one (a trust boundary: an error from the server).
 */
export function messageOf(error: unknown): MessageData | undefined {
	const details: unknown =
		typeof error === "object" && error !== null && "details" in error ? error.details : undefined;
	const message =
		typeof details === "object" && details !== null && "message" in details ? details.message : undefined;
	return typeof message === "object" && message !== null && "namespace" in message && "key" in message
		? (message as MessageData)
		: undefined;
}
