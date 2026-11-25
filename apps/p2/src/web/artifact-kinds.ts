// The artifact kinds of the page: the listable items plugins keep per session (the artifacts plugin's html and md
// pages, a plugin's boards or games), contributed by web facets and keyed by artifact kind. The artifacts plugin's
// button counts them and its sheet lists them; opening an item opens a view of the kind's `view` with the item's ID.
import type { ComponentType } from "react";
import { keyedRegistry } from "../runtime/chord.ts";

/** One item as the artifacts sheet lists it: its ID (the view's `item`), title, and when it last changed (ms). */
export type ArtifactItem = { readonly id: string; readonly title: string; readonly updated: number };

/**
 * An artifact kind. The hooks are live (a plugin's own server object, `useObject`/`useReadable`) and run in a component
 * of their own per kind, so their order holds: `useItems` lists the session's items (undefined while loading; the same
 * array while they are unchanged, as `useReadable` gives one), `useCount` counts them for the button without listing
 * them.
 */
export type ArtifactKind = {
	readonly title: string;
	readonly icon: ComponentType;
	readonly useItems: (session: string) => readonly ArtifactItem[] | undefined;
	readonly useCount: (session: string) => number | undefined;
	/** How an item's row shows in the sheet; without it, its icon, title and age. */
	readonly Row?: ComponentType<{ readonly item: ArtifactItem }>;
	/** The view kind (`ViewKinds`) that opens an item. */
	readonly view: string;
	/**
	 * A live hook: what deletes an item for this person, `undefined` while they may not (or while loading); without it
	 * the sheet offers no removal.
	 */
	readonly useRemove?: (session: string) => ((id: string) => Promise<void>) | undefined;
};

/** The artifact kinds, by kind. */
export const ArtifactKinds = keyedRegistry<ArtifactKind>("p2.artifact-kinds");
