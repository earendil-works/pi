// The things plugin's contract for web facets (decisions 60, 64 to 66, 70, 72, 74): the views a plugin offers for a
// target (`Views`: things of a kind, persons, groups; 0 to n each), what a kind has once (`ThingParts`: its title,
// icon, create step and settings form), and the components the page places: `TargetView`, which draws a target in its
// chosen view, the Settings view, the navigator, the add-thing picker and the invite dialog; the plugins' titles for
// the picker's headings and the sections of `/me`; and the hooks every view plugin may use: `useScreenId` (the id
// every list a page holds takes), `useMessageText` (a message of any plugin as text), `useErrorText` and `useAction`
// (what a failed call says to the person: guide 4.2, and a view's call with it) and `useNames` (a kind and a thing as
// the page names them). Tokens, data and hooks only: the base bundle carries this file, so no component lives here.
// The hooks, and the things plugin's page messages they read, are part of that bundle: a live apply of the things
// plugin does not change them for third-party plugins (built-in ones import this file by path and get the new code).
// `/v1/web` re-exports it.

import {
	BACKGROUND_CONTEXT,
	type Context,
	defineRegistry,
	type JsonValue,
	type MessageData,
	type TableItem,
	Translations,
} from "@earendil-works/p3/v1";
import { defineComponent, type Target, useMessages, usePageState, useRegistry } from "@earendil-works/p3/v1/web";
import { type ComponentType, useCallback, useState } from "react";
import { page } from "./page-messages.ts";

export type { Target } from "@earendil-works/p3/v1/web";

/**
 * The page's id for the lists it holds (a list contract's `view`: `Roots`, `WorkspaceContents`, ...): one per page, so
 * the navigator, the Settings view and a session's panes holding one list hold one object; two pages of one person never
 * share one. Kept in page state: a reload of a plugin keeps it. `getRandomValues` works on a page served over plain HTTP.
 */
export function useScreenId(): string {
	const [fresh] = useState(() =>
		Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
	return usePageState("things.screen-id", fresh)[0];
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

/**
 * Every view by the key of what it is for (`viewsKey`), each list in plugin order; any plugin contributes a list of
 * its views.
 */
export const Views = defineRegistry<readonly ViewEntry[], ReadonlyMap<string, readonly TableItem<ViewEntry>[]>>(
	"things.views",
	{ version: 1 },
);

/** The key `Views` groups its entries by: `thing/<kind>`, `person` or `group`. */
export function viewsKey(target: ViewFor): string {
	return target.kind === "thing" ? `thing/${target.thingKind}` : target.kind;
}

/**
 * What a kind's create step gets: the workspace it is made in, `onReady` for the input its create hook takes, and the
 * input it last reported (`undefined` at first): the step starts its form from it, so a live apply of its plugin keeps
 * what the person filled in.
 */
export type ThingCreateProps = {
	readonly workspace: string;
	readonly input: JsonValue | undefined;
	readonly onReady: (input: JsonValue) => void;
};

/**
 * What a kind's settings form gets (ERNDL-1141 §9, R40): the thing as it is linked in `workspace`, its settings'
 * current values and `save`, which sets some of them (`Workspace.configure`). Never the thing's own reference: the form
 * is workspace management, open to whoever has Configure there.
 */
export type ThingSettingsProps = {
	readonly workspace: string;
	readonly thing: string;
	readonly value: JsonValue;
	readonly save: (settings: JsonValue) => Promise<void>;
};

/**
 * What a kind has once, from its own plugin: its title (a message: the page never shows a kind's name), its icon
 * (none: a page icon), its create step (a sign-in, a token), and its form in the Settings view (not rendered until
 * the server read `things.thing-settings` exists: carry-over of ERNDL-734 and ERNDL-1143).
 */
export type ThingPartsEntry = {
	readonly kind: string;
	readonly title: MessageData;
	readonly Icon?: ComponentType;
	readonly Create?: ComponentType<ThingCreateProps>;
	readonly Settings?: ComponentType<ThingSettingsProps>;
};

/**
 * The kinds' parts by kind name, from lists their plugins contribute: the first by plugin name wins a kind, a second
 * is reported.
 */
export const ThingParts = defineRegistry<readonly ThingPartsEntry[], ReadonlyMap<string, TableItem<ThingPartsEntry>>>(
	"things.parts",
	{ version: 1 },
);

/** How a target shows: in a view beside the navigator, in one that takes the whole page, or in the Settings view. */
export type Shown = "main" | "page" | "settings";

/**
 * A target in a view (decision 70): `view` if it is one of the target's, else its default (the thing's own `view`,
 * the first by plugin name; an id no plugin has is skipped); with none, the Settings view. A kind's own default view
 * comes with "Open with…" (carry-over).
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

/** What a failed call says to the person: the message the server sent with it, else the error's own text. */
export function useErrorText(): (error: unknown) => string {
	const text = useMessageText();
	return (error) => {
		const message = messageOf(error);
		if (message !== undefined) return text(message);
		return error instanceof Error ? error.message : String(error);
	};
}

/** A call a view makes: whether one runs and the text of the last failure, as the person reads it. */
export type Action = {
	readonly pending: boolean;
	readonly error: string | undefined;
	/** Runs `call`; its failure is kept as `error` (`useErrorText`), never thrown. */
	run(call: (context: Context) => Promise<unknown>): void;
};

/** A view's call state and its `run`. */
export function useAction(): Action {
	const errorText = useErrorText();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const run = useCallback(
		(call: (context: Context) => Promise<unknown>) => {
			setPending(true);
			setError(undefined);
			call(BACKGROUND_CONTEXT)
				.catch((failure: unknown) => setError(errorText(failure)))
				.finally(() => setPending(false));
		},
		[errorText],
	);
	return { pending, error, run };
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

/**
 * How the page names a kind (its title, `ThingParts`) and a thing (its name, else its kind's title): never a kind's
 * id (decision 65). A kind no plugin gives parts reads "A thing".
 */
export function useNames(): {
	readonly kind: (kind: string) => string;
	readonly thing: (kind: string, name: string | undefined) => string;
} {
	const { t } = useMessages(page);
	const text = useMessageText();
	const parts = useRegistry(ThingParts);
	const kind = (name: string) => {
		const title = parts?.get(name)?.value.title;
		return title === undefined ? t("aThing") : text(title);
	};
	return { kind, thing: (of, name) => (name === undefined || name === "" ? kind(of) : name) };
}
