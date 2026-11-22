// The sessions plugin's contract for web facets: the views it offers apps (the session list, new session, what a
// session has), and `ThingViews`, through which each kind of thing shows one thing of a session (`<ThingView>`
// renders the right one, so an app never knows kinds). `/v1/web` re-exports it.

import { defineRegistry, type TableItem } from "@earendil-works/p3/v1";
import { defineView, useRegistry } from "@earendil-works/p3/v1/web";
import type { ComponentType, ReactNode } from "react";

/** One thing of a session, as its view gets it. */
export type ThingViewProps = { readonly session: string; readonly thing: string };

/** A kind's view of one thing: the kind's name and its component (the thing's object admits the viewer). */
export type ThingViewEntry = { readonly kind: string; readonly View: ComponentType<ThingViewProps> };

/** The kinds' views of a thing by kind name (the first by plugin name wins a kind; a second is reported). */
export const ThingViews = defineRegistry<ThingViewEntry, ReadonlyMap<string, TableItem<ThingViewEntry>>>(
	"sessions.thing-views",
	{ version: 1 },
);

/** Thing `thing` of `session` (of `kind`) in its kind's view; `fallback` while no plugin shows the kind. */
export function ThingView(props: ThingViewProps & { readonly kind: string; readonly fallback?: ReactNode }) {
	const View = useRegistry(ThingViews)?.get(props.kind)?.value.View;
	return View === undefined ? (props.fallback ?? null) : <View session={props.session} thing={props.thing} />;
}

/** An app's sessions as a list the caller may open (`onOpen`), active or archived. */
export const SessionListView = defineView<{
	readonly app: string;
	readonly selected?: string;
	readonly onOpen: (session: string) => void;
}>("sessions.list");

/** A form that makes a session of `app` (the owner's: title and location); `onCreated` gets its id. */
export const NewSessionView = defineView<{
	readonly app: string;
	readonly things?: readonly { readonly kind: string }[];
	readonly onCreated: (session: string) => void;
}>("sessions.new");

/** What a session holds (its things and members), opened on demand; the owner manages them there. */
export const SessionThingsView = defineView<{ readonly session: string }>("sessions.things");
