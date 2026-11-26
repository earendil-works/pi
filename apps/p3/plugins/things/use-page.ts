// What the things plugin's page parts share: a list's screen id, every registered kind by name, a message of any
// plugin as text, how a "from" reads, and what a party opens.

import { type MessageData, Translations } from "@earendil-works/p3/v1";
import { type Target, useHold, useLive, useMessages, useRegistry, useWatch } from "@earendil-works/p3/v1/web";
import { useMemo, useState } from "react";
import type { Party } from "./contract.ts";
import { type KindView, ThingKindsView } from "./kind.ts";
import { page } from "./page-messages.ts";
import type { Origin } from "./workspace.ts";

/**
 * A fresh id for one mounted list (a list contract's `view`), kept while it stays mounted: two pages of one person
 * never share a list. `getRandomValues` works on a page served over plain HTTP too.
 */
export function useScreenId(): string {
	const [id] = useState(() =>
		Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
	return id;
}

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

/**
 * A message of any plugin (a tick's label, a view's title) as text in the page's language, from the catalogs plugins
 * contribute to `Translations`; a message no catalog has shows its key.
 */
export function useMessageText(): (message: MessageData) => string {
	const index = useRegistry(Translations);
	const { locale } = useMessages(page);
	return ({ namespace, key, params }) => {
		const catalogs = index?.catalogs.get(namespace);
		const catalog = (locale === undefined ? undefined : catalogs?.get(locale)) ?? catalogs?.values().next().value;
		const value = catalog?.value.messages[key];
		if (value === undefined) return key;
		// A catalog's value is a text or a function of the message's params (`defineMessages`).
		return typeof value === "string" ? value : (value as (...args: readonly unknown[]) => string)(...params);
	};
}
