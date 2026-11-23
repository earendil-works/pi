// The sessions plugin's contract for web facets: the views it offers apps (the session list, new session, what a
// session has), and `ThingViews`, through which each kind of thing shows one thing of a session (`<ThingView>`
// renders the right one, so an app never knows kinds). `/v1/web` re-exports it.

import { defineRegistry, type JsonValue, type OptionsFor, type TableItem, type ThingUse } from "@earendil-works/p3/v1";
import { defineView, useRegistry } from "@earendil-works/p3/v1/web";
import type { ComponentType, ReactNode } from "react";

/** One thing of a session, as its view gets it. */
export type ThingViewProps = { readonly session: string; readonly thing: string };

/**
 * A kind's options form for one thing, as `SessionThingsView` shows it to whoever may set the thing's options: the
 * options it edits (whose they are the view picks: everyone's, the agent's, a member's; `null` when none the kind
 * reads now: the form starts from its kind's initial ones) and `onSave`, which sets them for whom they are.
 */
export type ThingOptionsProps = {
	readonly session: string;
	readonly thing: string;
	readonly for: OptionsFor;
	readonly options: JsonValue | null;
	readonly onSave: (forWhom: OptionsFor, options: JsonValue) => void;
};

/**
 * A kind's creation view, shown inside the base's "New thing" dialog (My things) for a kind of `creation: "person"`
 * that needs a step of its own (a sign-in): it runs that step with its plugin's own objects and hands the dialog the
 * input its `create` hook takes (`onReady`; a random sign-in id, never a secret). Without one the dialog makes the
 * thing at once, with no input.
 */
export type ThingCreateProps = { readonly onReady: (input: JsonValue) => void };

/**
 * A kind's view of one thing: the kind's name, its component (the thing's object admits the viewer; none for a kind
 * with nothing to show but its title, such as the coding tools: an app offers no pane for it), for a kind with
 * options people set in the page its options form, and its creation view (see `ThingCreateProps`).
 */
export type ThingViewEntry = {
	readonly kind: string;
	/** The kind's icon (one of `/v1/web`'s), shown beside its things' names; none: a page icon. */
	readonly Icon?: ComponentType;
	readonly View?: ComponentType<ThingViewProps>;
	readonly Options?: ComponentType<ThingOptionsProps>;
	readonly Create?: ComponentType<ThingCreateProps>;
};

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

/** A form that makes a session of `app` (the owner's: title and location) with `things`; `onCreated` gets its id. */
export const NewSessionView = defineView<{
	readonly app: string;
	readonly things?: readonly ThingUse[];
	readonly onCreated: (session: string) => void;
}>("sessions.new");

/**
 * What a session holds (its things and members), opened on demand; the owner manages them there. With `onOpen`, each
 * thing whose kind has a view offers "Open", which hands its id to the app (to show it where the app shows things);
 * the dialog never shows a thing's view itself.
 */
export const SessionThingsView = defineView<{
	readonly session: string;
	readonly onOpen?: (thing: string) => void;
}>("sessions.things");

/**
 * The things a person manages outside sessions (their own, their groups', the Pi's for the owner): make one of a
 * `creation: "person"` kind (its kind's creation view in the dialog), "in all my sessions", rename, give away,
 * delete, and where each is used.
 */
export const MyThingsView = defineView<Record<string, never>>("sessions.my-things");

/**
 * Who is in a session (persons and groups, reading or writing), opened on demand ("Share"): everyone with access sees
 * it; the owner adds and removes members there.
 */
export const SessionMembersView = defineView<{ readonly session: string }>("sessions.members");
