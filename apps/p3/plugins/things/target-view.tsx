// `TargetView` (decision 70): a target in its view. Which view: `?view=` if it is one of the target's, then the thing's
// own `view`, then the first by plugin name (an id no plugin has is skipped, 74; a kind's own default view is
// carry-over of ERNDL-734); with none, the Settings view. A thing is read as it is available here (`ThingInfo`,
// admitted by the caller's answer: its denial is the link's message; a workspace below addressed as a thing goes to its
// own address); a workspace as `Workspace` says it.

import type { RefState } from "@earendil-works/p3/v1";
import {
	redirect,
	type Target,
	targetPath,
	useComponent,
	useHold,
	useLive,
	useRefState,
	useRegistry,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ComponentType, useEffect } from "react";
import {
	type GroupViewProps,
	type PersonViewProps,
	Settings,
	type Shown,
	type ThingViewProps,
	type ViewFor,
	Views,
	viewsKey,
} from "./contract.web.tsx";
import styles from "./things.module.css";
import { useUnavailable } from "./use-page.ts";
import { ThingInfo, Workspace } from "./workspace.ts";

/** What `TargetView` takes (the token's props). */
type Props = {
	readonly target: Target;
	readonly view?: string | undefined;
	readonly onShown?: (shown: Shown) => void;
};

/** The target in its view, or why it is not shown; `onShown` hears how it shows. */
export function TargetView(props: Props) {
	const { target } = props;
	switch (target.kind) {
		case "thing":
			return <ThingTarget {...props} of={{ workspace: target.workspace, thing: target.thing }} />;
		case "workspace":
			return <WorkspaceTarget {...props} of={{ workspace: target.workspace, thing: target.workspace }} />;
		case "person":
			return (
				<Chosen {...props} for={{ kind: "person" }} of={{ workspace: target.workspace, person: target.person }} />
			);
		case "group":
			return <Chosen {...props} for={{ kind: "group" }} of={{ workspace: target.workspace, group: target.group }} />;
	}
}

/** A thing as it is available in its workspace (`ThingInfo`). */
function ThingTarget(props: Props & { readonly of: ThingViewProps }) {
	const ref = useHold(ThingInfo, props.of);
	return <Held {...props} info={useWatch(useLive(ref)?.info)} state={useRefState(ref)} />;
}

/** A workspace as `Workspace` says it; its view gets it as the thing (`thing === workspace`). */
function WorkspaceTarget(props: Props & { readonly of: ThingViewProps }) {
	const ref = useHold(Workspace, { workspace: props.of.workspace });
	return <Held {...props} info={useWatch(useLive(ref)?.info)} state={useRefState(ref)} />;
}

/** A held thing: its denial's message, nothing until its kind is known, then its view. */
function Held(
	props: Props & {
		readonly of: ThingViewProps;
		readonly info: { readonly kind: string; readonly view?: string | undefined } | undefined;
		readonly state: RefState | undefined;
	},
) {
	const { info, state } = props;
	const unavailable = useUnavailable(state);
	if (unavailable !== undefined) {
		return (
			<Unavailable
				settings={false}
				text={unavailable}
				thing={props.of.thing}
				view={props.view}
				workspace={props.of.workspace}
			/>
		);
	}
	// Before its first value arrives a member holds its schema's empty one: a kind is never empty.
	if (info === undefined || info.kind === "") return null;
	return <Chosen {...props} for={{ kind: "thing", thingKind: info.kind }} own={info.view} />;
}

/**
 * Picks the view among those `for` this target and draws it with `of`: `view`, the thing's `own`, the first by plugin
 * name; none: the Settings view. Only a decided view is reported (`onShown`): while loading the
 * chrome keeps what it shows.
 */
function Chosen(
	props: Props & {
		readonly for: ViewFor;
		readonly of: ThingViewProps | PersonViewProps | GroupViewProps;
		readonly own?: string | undefined;
	},
) {
	const views = useRegistry(Views);
	const SettingsView = useComponent(Settings);
	const { onShown } = props;
	const offered = views?.get(viewsKey(props.for)) ?? [];
	const chosen = [props.view, props.own]
		.map((id) => offered.find((item) => item.value.view === id))
		.find((item) => item !== undefined);
	const entry = (chosen ?? offered[0])?.value;
	const shown: Shown | undefined = views === undefined ? undefined : (entry?.area ?? "settings");
	useEffect(() => {
		if (shown !== undefined) onShown?.(shown);
	}, [shown, onShown]);
	if (shown === undefined) return null;
	if (entry === undefined) return SettingsView === undefined ? null : <SettingsView target={props.target} />;
	// The entry was found under `for`'s key, so its `View` takes `of`; TypeScript cannot narrow an entry by `for.kind`,
	// a field of a field.
	const View = entry.View as ComponentType<typeof props.of>;
	return <View {...props.of} />;
}

/**
 * Why a thing is not shown here, or, for a workspace below `workspace` addressed as one of its things
 * (`/w/<parent>/t/<child>`), the workspace's own address: a workspace is placed by its parent, never linked, so no
 * answer names it there. Its `Workspace` is held only after a denial, and is given only to whoever is present in it.
 */
export function Unavailable(props: {
	readonly workspace: string;
	readonly thing: string;
	readonly settings: boolean;
	readonly view: string | undefined;
	readonly text: string;
}) {
	const { workspace, thing, settings, view } = props;
	const parent = useWatch(useLive(useHold(Workspace, { workspace: thing }))?.info)?.parent?.workspace;
	const child = parent === workspace;
	useEffect(() => {
		if (child) redirect(targetPath({ kind: "workspace", workspace: thing }, { settings, view }));
	}, [child, thing, settings, view]);
	if (child) return null;
	return (
		<p className={styles.note} data-denied="">
			{props.text}
		</p>
	);
}
