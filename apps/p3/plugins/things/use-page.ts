// What the things plugin's page parts share: every registered kind by name, how a "from" reads, what a party opens,
// how a party is named, what a denial or a gone target says, and whether the window is wide.

import type { RefState } from "@earendil-works/p3/v1";
import { type Target, useHold, useLive, useMessages, useWatch } from "@earendil-works/p3/v1/web";
import { useMemo, useSyncExternalStore } from "react";
import type { Party } from "./contract.ts";
import { messageOf, useMessageText } from "./contract.web.tsx";
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
				return t("aSessionsAgent");
			default:
				return name;
		}
	};
}

/**
 * What the page says of a reference that cannot show its target: its denial's message (or a plain "no access"), or,
 * ended or broken, "not available" (never whether the target exists); `undefined` while it can.
 */
export function useUnavailable(state: RefState | undefined): string | undefined {
	const { t } = useMessages(page);
	const text = useMessageText();
	switch (state?.kind) {
		case undefined:
		case "loading":
		case "live":
			return undefined;
		case "ended":
			return t("unavailable");
		case "failed": {
			if (state.cause.kind === "broken") return t("unavailable");
			if (state.cause.kind !== "denied") return undefined;
			const message = messageOf(state.cause.error);
			return message === undefined ? t("denied") : text(message);
		}
	}
}

/** Whether the window is a tablet's or wider (48rem): a part with a wide and a phone form renders only one. */
export function useWide(): boolean {
	return useSyncExternalStore(subscribeWide, isWide, () => true);
}

/** The media query of the wide forms (the layout plugin's pane layout has its own copy: no shared file between them). */
const WIDE = "(min-width: 48rem)";

/** Subscribes `changed` to the window crossing `WIDE`. */
function subscribeWide(changed: () => void): () => void {
	const query = matchMedia(WIDE);
	query.addEventListener("change", changed);
	return () => query.removeEventListener("change", changed);
}

/** Whether the window is `WIDE`. */
function isWide(): boolean {
	return matchMedia(WIDE).matches;
}
