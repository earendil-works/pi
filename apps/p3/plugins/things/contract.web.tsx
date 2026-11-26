// The things plugin's contract for web facets (decisions 60, 64 to 66, 70, 72, 74): the views a plugin offers for a
// target (`Views`: things of a kind, persons, groups; 0 to n each), what a kind has once (`ThingParts`: its icon,
// create step, settings form, default view), and the components the page places: `TargetView`, which draws a target
// in its chosen view, the Settings view, the navigator, the add-thing picker and the invite dialog; the plugins'
// titles for the picker's headings and the sections of `/me`; and `useScreenId`, the id every list a view holds
// takes. Tokens and data only (the base bundle carries this file, so no component lives here); `/v1/web` re-exports
// it.

import { defineRegistry, type JsonValue, type MessageData, type TableItem } from "@earendil-works/p3/v1";
import { defineComponent, type Target } from "@earendil-works/p3/v1/web";
import { type ComponentType, useState } from "react";

export type { Target } from "@earendil-works/p3/v1/web";

/**
 * A fresh id for one mounted list (a list contract's `view`: `Roots`, `WorkspaceContents`, ...), kept while it stays
 * mounted: two pages of one person never share a list. `getRandomValues` works on a page served over plain HTTP too.
 */
export function useScreenId(): string {
	const [id] = useState(() =>
		Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
	return id;
}

/** A thing as its view gets it, seen from a workspace; a workspace's own view gets `thing === workspace`. */
export type ThingViewProps = { readonly workspace: string; readonly thing: string };

/** A person as their view gets them, seen from a workspace. */
export type PersonViewProps = { readonly workspace: string; readonly person: string };

/** A group as its view gets it, seen from a workspace. */
export type GroupViewProps = { readonly workspace: string; readonly group: string };

/** What a view is for: things of one kind (a workspace kind among them), persons, or groups. */
export type ViewFor =
	| { readonly kind: "thing"; readonly thingKind: string }
	| { readonly kind: "person" }
	| { readonly kind: "group" };

/**
 * What every view has: its id (unique among the views for its target), its title under "Open with…" (a message,
 * decision 65), and whether it sits beside the navigator (`main`) or takes the whole page (`page`, decision 64: it may
 * draw its own navigation; the chrome keeps one corner button). Every view works on phones and desktops (66).
 */
type ViewBase = { readonly view: string; readonly title: MessageData; readonly area: "main" | "page" };

/** One way to look at a thing of a kind, a person or a group. */
export type ViewEntry =
	| (ViewBase & {
			readonly for: { readonly kind: "thing"; readonly thingKind: string };
			readonly View: ComponentType<ThingViewProps>;
	  })
	| (ViewBase & { readonly for: { readonly kind: "person" }; readonly View: ComponentType<PersonViewProps> })
	| (ViewBase & { readonly for: { readonly kind: "group" }; readonly View: ComponentType<GroupViewProps> });

/** Every view by the key of what it is for (`viewsKey`), each list in plugin order; any plugin may contribute. */
export const Views = defineRegistry<ViewEntry, ReadonlyMap<string, readonly TableItem<ViewEntry>[]>>("things.views", {
	version: 1,
});

/** The key `Views` groups its entries by: `thing/<kind>`, `person` or `group`. */
export function viewsKey(target: ViewFor): string {
	return target.kind === "thing" ? `thing/${target.thingKind}` : target.kind;
}

/** What a kind's create step gets: the workspace it is made in, and `onReady` for the input its create hook takes. */
export type ThingCreateProps = { readonly workspace: string; readonly onReady: (input: JsonValue) => void };

/**
 * What a kind has once, from its own plugin: its icon (none: a page icon), its create step (a sign-in, a token), its
 * form in the Settings view, and its default view (an id among its `Views`).
 */
export type ThingPartsEntry = {
	readonly kind: string;
	readonly Icon?: ComponentType;
	readonly Create?: ComponentType<ThingCreateProps>;
	readonly Settings?: ComponentType<ThingViewProps>;
	readonly defaultView?: string;
};

/** The kinds' parts by kind name: the first by plugin name wins a kind, a second is reported. */
export const ThingParts = defineRegistry<ThingPartsEntry, ReadonlyMap<string, TableItem<ThingPartsEntry>>>(
	"things.parts",
	{ version: 1 },
);

/** How a target shows: in a view beside the navigator, in one that takes the whole page, or in the Settings view. */
export type Shown = "main" | "page" | "settings";

/**
 * A target in a view (decision 70): `view` if it is one of the target's, else its default (the thing's own `view`,
 * its kind's `defaultView`, the first by plugin name; an id no plugin has is skipped); with none, the Settings view.
 * `onShown` hears how it shows, so the chrome can give a whole-page view the page.
 */
export const TargetView = defineComponent<{
	readonly target: Target;
	readonly view?: string | undefined;
	readonly onShown?: (shown: Shown) => void;
}>("things.target-view");

/** The Settings view of a target (the things plugin's): what the gear and `/settings` open. */
export const Settings = defineComponent<{ readonly target: Target }>("things.settings");

/** The add-thing picker of a workspace, grouped by plugin; `onAdded` gets the thing made or linked. */
export const AddThing = defineComponent<{
	readonly workspace: string;
	readonly onAdded: (thing: string) => void;
	readonly onClose: () => void;
}>("things.add");

/** The invite dialog of a workspace: someone already on this Pi, or someone new by link. */
export const Invite = defineComponent<{ readonly workspace: string; readonly onClose: () => void }>("things.invite");

/**
 * The navigator, the chrome's sidebar slot: `target` is what the main area shows (the entry to highlight); a click
 * asks the chrome to open a target with `onOpen` (the navigator never navigates itself), the person's own page with
 * `onMe`. The things plugin provides one; another plugin may provide its own.
 */
export const Navigator = defineComponent<{
	readonly target: Target | undefined;
	readonly onOpen: (target: Target) => void;
	readonly onMe: () => void;
}>("things.navigator");

/** A plugin's title and icon, the add-thing picker's heading for its kinds (R22, item 61). */
export type PluginTitle = { readonly title: MessageData; readonly Icon?: ComponentType };

/** The plugins' titles by plugin name (`TableItem.plugin`); a plugin contributes its own once. */
export const PluginTitles = defineRegistry<PluginTitle, ReadonlyMap<string, TableItem<PluginTitle>>>(
	"things.plugin-titles",
	{ version: 1 },
);

/** One section of a person's own page, `/me` (sign-ins, identities, preferences): only the person sees it. */
export type MeSection = { readonly id: string; readonly title: MessageData; readonly Section: ComponentType };

/** The sections of `/me`, in plugin order. */
export const MeSections = defineRegistry<MeSection, readonly TableItem<MeSection>[]>("things.me-sections", {
	version: 1,
});
