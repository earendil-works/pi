// `TargetView` (decision 70): a target in its view. Which view: `?view=` if it is one of the target's, then the thing's
// own `view`, then its kind's `defaultView`, then the first by plugin name (an id no plugin has is skipped, 74); with
// none, the Settings view. A thing is read as it is available here (`ThingInfo`, admitted by the caller's answer: its
// denial is the link's message); a workspace as `Workspace` says it.

import type { MessageData, RefState, TableItem } from "@earendil-works/p3/v1";
import {
	type Target,
	useComponent,
	useHold,
	useLive,
	useMessages,
	useRefState,
	useRegistry,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ReactNode, useEffect } from "react";
import { Settings, type Shown as ShownArea, ThingParts, type ViewEntry, Views, viewsKey } from "./contract.web.tsx";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { useMessageText } from "./use-page.ts";
import { ThingInfo, Workspace } from "./workspace.ts";

/** How a target shows: still loading, denied (with what to say), in a view, or in the Settings view. */
export type Shown =
	| { readonly kind: "loading" }
	| { readonly kind: "denied"; readonly message: string }
	| { readonly kind: "view"; readonly entry: TableItem<ViewEntry> }
	| { readonly kind: "settings" };

/** The target in its view, or why it is not shown; `onShown` hears how it shows. */
export function TargetView(props: {
	readonly target: Target;
	readonly view?: string;
	readonly onShown?: (shown: ShownArea) => void;
}) {
	return (
		<Resolve
			render={(shown) => <ShownView onShown={props.onShown} shown={shown} target={props.target} />}
			target={props.target}
			view={props.view}
		/>
	);
}

/** What `shown` says for `target`: nothing yet, the denial, the Settings view or the chosen view. */
function ShownView(props: {
	readonly shown: Shown;
	readonly target: Target;
	readonly onShown: ((shown: ShownArea) => void) | undefined;
}) {
	const SettingsView = useComponent(Settings);
	const { t } = useMessages(page);
	const { shown, target, onShown } = props;
	// Only a decided view is reported: while loading the chrome keeps what it shows, so it does not flip back and forth.
	const area: ShownArea | undefined =
		shown.kind === "view" ? shown.entry.value.area : shown.kind === "settings" ? "settings" : undefined;
	useEffect(() => {
		if (area !== undefined) onShown?.(area);
	}, [area, onShown]);
	switch (shown.kind) {
		case "loading":
			return null;
		case "denied":
			return (
				<p className={styles.note} data-denied="">
					{shown.message}
				</p>
			);
		case "settings":
			return SettingsView === undefined ? null : <SettingsView target={target} />;
		case "view":
			return <EntryView entry={shown.entry.value} fallback={t("noView")} target={target} />;
	}
}

/**
 * Works out how `target` shows in `view` (or its default) and renders `render` with it; the chrome uses it too, to
 * know whether the view takes the whole page.
 */
export function Resolve(props: {
	readonly target: Target;
	readonly view?: string;
	readonly render: (shown: Shown) => ReactNode;
}) {
	const { target } = props;
	switch (target.kind) {
		case "thing":
			return <ThingResolve render={props.render} target={target} view={props.view} />;
		case "workspace":
			return <WorkspaceResolve render={props.render} view={props.view} workspace={target.workspace} />;
		case "person":
		case "group":
			return (
				<Chosen
					of={{ kind: "found", key: viewsKey({ kind: target.kind }), thingKind: undefined, view: undefined }}
					render={props.render}
					view={props.view}
				/>
			);
	}
}

/** What a target is: still loading, denied with what to say, or found with its views' key and own default view. */
type Of =
	| { readonly kind: "loading" }
	| { readonly kind: "denied"; readonly message: string }
	| {
			readonly kind: "found";
			readonly key: string;
			readonly thingKind: string | undefined;
			readonly view: string | undefined;
	  };

/** A thing as it is available in its workspace (`ThingInfo`). */
function ThingResolve(props: {
	readonly target: Extract<Target, { readonly kind: "thing" }>;
	readonly view: string | undefined;
	readonly render: (shown: Shown) => ReactNode;
}) {
	const ref = useHold(ThingInfo, { workspace: props.target.workspace, thing: props.target.thing });
	const info = useWatch(useLive(ref)?.info);
	const denied = useDenied(useRefState(ref));
	const of: Of =
		denied ??
		(info === undefined || info.kind === ""
			? { kind: "loading" }
			: {
					kind: "found",
					key: viewsKey({ kind: "thing", thingKind: info.kind }),
					thingKind: info.kind,
					view: info.view,
				});
	return <Chosen of={of} render={props.render} view={props.view} />;
}

/** A workspace as `Workspace` says it. */
function WorkspaceResolve(props: {
	readonly workspace: string;
	readonly view: string | undefined;
	readonly render: (shown: Shown) => ReactNode;
}) {
	const ref = useHold(Workspace, { workspace: props.workspace });
	const info = useWatch(useLive(ref)?.info);
	const denied = useDenied(useRefState(ref));
	const of: Of =
		denied ??
		(info === undefined || info.name === ""
			? { kind: "loading" }
			: {
					kind: "found",
					key: viewsKey({ kind: "thing", thingKind: info.kind }),
					thingKind: info.kind,
					view: info.view,
				});
	return <Chosen of={of} render={props.render} view={props.view} />;
}

/** The denial a reference's state shows, with its message rendered, if it was denied. */
function useDenied(state: RefState | undefined): Of | undefined {
	const { t } = useMessages(page);
	const text = useMessageText();
	if (state?.kind !== "failed" || state.cause.kind !== "denied") return undefined;
	const details: unknown = state.cause.error.details;
	const message =
		typeof details === "object" && details !== null && "message" in details ? details.message : undefined;
	return { kind: "denied", message: isMessage(message) ? text(message) : t("denied") };
}

/** Whether a denial's details carry a message as data (a trust boundary: an error from the server). */
function isMessage(value: unknown): value is MessageData {
	return typeof value === "object" && value !== null && "namespace" in value && "key" in value;
}

/** Picks the view: `view`, the thing's own, the kind's default, the first by plugin name; none: the Settings view. */
function Chosen(props: {
	readonly of: Of;
	readonly view: string | undefined;
	readonly render: (shown: Shown) => ReactNode;
}) {
	const views = useRegistry(Views);
	const parts = useRegistry(ThingParts);
	const { of } = props;
	if (of.kind !== "found") return props.render(of);
	if (views === undefined || parts === undefined) return props.render({ kind: "loading" });
	const offered = views.get(of.key) ?? [];
	const defaultView = of.thingKind === undefined ? undefined : parts.get(of.thingKind)?.value.defaultView;
	for (const id of [props.view, of.view, defaultView]) {
		const entry = offered.find((item) => item.value.view === id);
		if (entry !== undefined) return props.render({ kind: "view", entry });
	}
	const first = offered[0];
	return props.render(first === undefined ? { kind: "settings" } : { kind: "view", entry: first });
}

/** `entry`'s component with the props of its target kind. */
function EntryView(props: { readonly entry: ViewEntry; readonly target: Target; readonly fallback: string }) {
	const { entry, target } = props;
	switch (entry.for.kind) {
		case "thing": {
			const View = (entry as Extract<ViewEntry, { readonly for: { readonly kind: "thing" } }>).View;
			const thing = target.kind === "thing" ? target.thing : target.workspace;
			return <View thing={thing} workspace={target.workspace} />;
		}
		case "person": {
			const View = (entry as Extract<ViewEntry, { readonly for: { readonly kind: "person" } }>).View;
			return target.kind === "person" ? <View person={target.person} workspace={target.workspace} /> : null;
		}
		case "group": {
			const View = (entry as Extract<ViewEntry, { readonly for: { readonly kind: "group" } }>).View;
			return target.kind === "group" ? <View group={target.group} workspace={target.workspace} /> : null;
		}
	}
}
