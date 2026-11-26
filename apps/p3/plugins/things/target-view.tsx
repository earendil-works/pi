// `TargetView` (decision 70): a target in its view. Which view: `?view=` if it is one of the target's, then the thing's
// own `view`, then its kind's `defaultView`, then the first by plugin name (an id no plugin has is skipped, 74); with
// none, the Settings view. A thing is read as it is available here (`ThingInfo`, admitted by the caller's answer: its
// denial is the link's message); a workspace as `Workspace` says it.

import type { RefState } from "@earendil-works/p3/v1";
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
import { type ComponentType, useEffect } from "react";
import {
	type GroupViewProps,
	type PersonViewProps,
	Settings,
	type Shown,
	ThingParts,
	type ThingViewProps,
	type ViewFor,
	Views,
	viewsKey,
} from "./contract.web.tsx";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { messageOf, useMessageText } from "./use-page.ts";
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
	const { t } = useMessages(page);
	const text = useMessageText();
	const { info, state } = props;
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		const message = messageOf(state.cause.error);
		return (
			<p className={styles.note} data-denied="">
				{message === undefined ? t("denied") : text(message)}
			</p>
		);
	}
	// Before its first value arrives a member holds its schema's empty one: a kind is never empty.
	if (info === undefined || info.kind === "") return null;
	return <Chosen {...props} for={{ kind: "thing", thingKind: info.kind }} own={info.view} />;
}

/**
 * Picks the view among those `for` this target and draws it with `of`: `view`, the thing's `own`, the kind's default,
 * the first by plugin name; none: the Settings view. Only a decided view is reported (`onShown`): while loading the
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
	const parts = useRegistry(ThingParts);
	const SettingsView = useComponent(Settings);
	const { onShown } = props;
	const offered = views?.get(viewsKey(props.for)) ?? [];
	const kindDefault = props.for.kind === "thing" ? parts?.get(props.for.thingKind)?.value.defaultView : undefined;
	const chosen = [props.view, props.own, kindDefault]
		.map((id) => offered.find((item) => item.value.view === id))
		.find((item) => item !== undefined);
	const entry = (chosen ?? offered[0])?.value;
	const shown: Shown | undefined =
		views === undefined || parts === undefined ? undefined : (entry?.area ?? "settings");
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
