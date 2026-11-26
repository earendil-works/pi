// The navigator (R8, items 87 and 96), Elanor's side navigation: the person's own entry first (it opens `/me`), then
// the workspaces they are present in, topmost first (`Roots`). The workspaces above the open one show their
// children; the open one shows four groups: Sessions (its sub-workspaces and sessions), Here (things linked here),
// From above (greyed, "from <workspace>"; hidden ones folded into "N hidden") and People (put in here; from above
// greyed; hidden folded). Every entry opens its target in the main area through `onOpen`; nothing here navigates.

import { Collapsible, SideNavigation } from "@earendil-works/elanor-react";
import { Me } from "@earendil-works/p3/v1";
import {
	ChevronRightIcon,
	DescriptionIcon,
	GroupIcon,
	PersonIcon,
	type Target,
	targetPath,
	useHold,
	useLive,
	useMessages,
	useRegistry,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { type ComponentType, type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { partyKey } from "./contract.ts";
import { ThingParts } from "./contract.web.tsx";
import { page } from "./page-messages.ts";
import styles from "./things.module.css";
import { partyTarget, useFromText, useScreenId } from "./use-page.ts";
import { Roots, Workspace, WorkspaceChildren, WorkspaceContents, WorkspacePeople } from "./workspace.ts";

/** What the navigator gets from the chrome (`Navigator`'s props). */
type NavigatorProps = {
	readonly target: Target | undefined;
	readonly onOpen: (target: Target) => void;
	readonly onMe: () => void;
};

/** The navigator: the person's entry, then their topmost workspaces with the open one's path unfolded. */
export function NavigatorTree(props: NavigatorProps) {
	const { t } = useMessages(page);
	const me = useWatch(useLive(useHold(Me, {}))?.me);
	const roots = useWatch(useLive(useHold(Roots, { view: useScreenId() }))?.list);
	const [path, setPath] = useState<readonly string[]>([]);
	const open = props.target?.workspace;
	return (
		<SideNavigation.Root className={styles.navigator} data-navigator="">
			{open === undefined ? null : <Path at={open} below={[]} key={open} onDone={setPath} />}
			<SideNavigation.Group>
				<SideNavigation.List>
					<SideNavigation.Item>
						<SideNavigation.Link
							data-nav-me=""
							href="/me"
							iconStart={<PersonIcon />}
							onClick={(event) => follow(event, props.onMe)}
						>
							{me?.kind === "person" ? me.name : t("me")}
						</SideNavigation.Link>
					</SideNavigation.Item>
				</SideNavigation.List>
			</SideNavigation.Group>
			<SideNavigation.Group>
				<SideNavigation.GroupLabel>{t("workspaces")}</SideNavigation.GroupLabel>
				<SideNavigation.List>
					{(roots?.rows ?? []).map((root) => (
						<WorkspaceEntry key={root.workspace} {...props} path={path} row={root} />
					))}
				</SideNavigation.List>
			</SideNavigation.Group>
		</SideNavigation.Root>
	);
}

/** Collects the open workspace's path, its topmost workspace first, holding each `Workspace` up to a root. */
function Path(props: {
	readonly at: string;
	readonly below: readonly string[];
	readonly onDone: (path: string[]) => void;
}) {
	const info = useWatch(useLive(useHold(Workspace, { workspace: props.at }))?.info);
	const parent = info?.parent?.workspace;
	const { onDone, below, at } = props;
	useEffect(() => {
		if (info !== undefined && parent === undefined) onDone([at, ...below]);
	}, [info, parent, at, below, onDone]);
	return parent === undefined ? null : <Path at={parent} below={[at, ...below]} onDone={onDone} />;
}

/** One workspace: its link; on the open path its children, and for the open one its four groups. */
function WorkspaceEntry(
	props: NavigatorProps & {
		readonly row: { readonly workspace: string; readonly kind: string; readonly name: string };
		readonly path: readonly string[];
	},
) {
	const { row } = props;
	const target: Target = { kind: "workspace", workspace: row.workspace };
	const isOpen = props.target?.workspace === row.workspace;
	const onPath = props.path.includes(row.workspace);
	return (
		<SideNavigation.Item>
			<EntryLink
				active={isOpen && props.target?.kind === "workspace"}
				data={{ "data-nav-workspace": row.workspace }}
				Icon={useKindIcon(row.kind)}
				onOpen={props.onOpen}
				target={target}
			>
				{row.name}
			</EntryLink>
			{isOpen ? (
				<OpenGroups {...props} workspace={row.workspace} />
			) : onPath ? (
				<Children {...props} workspace={row.workspace} />
			) : null}
		</SideNavigation.Item>
	);
}

/** A workspace's children, as entries (on the open one's path). */
function Children(props: NavigatorProps & { readonly workspace: string; readonly path: readonly string[] }) {
	const children = useWatch(
		useLive(useHold(WorkspaceChildren, { workspace: props.workspace, view: useScreenId() }))?.list,
	);
	if (children === undefined || children.rows.length === 0) return null;
	return (
		<SideNavigation.List className={styles.nested}>
			{children.rows.map((child) => (
				<WorkspaceEntry key={child.workspace} {...props} row={child} />
			))}
		</SideNavigation.List>
	);
}

/** The open workspace's four groups. */
function OpenGroups(props: NavigatorProps & { readonly workspace: string; readonly path: readonly string[] }) {
	const { t } = useMessages(page);
	const view = useScreenId();
	const children = useWatch(useLive(useHold(WorkspaceChildren, { workspace: props.workspace, view }))?.list);
	const contents = useWatch(useLive(useHold(WorkspaceContents, { workspace: props.workspace, view }))?.list);
	const people = useWatch(useLive(useHold(WorkspacePeople, { workspace: props.workspace, view }))?.list);
	const fromText = useFromText();
	const things = contents?.rows ?? [];
	const thingRow = (row: (typeof things)[number]) => (
		<ThingEntry key={row.thing} {...props} from={fromText(row.from)} row={row} workspace={props.workspace} />
	);
	const here = things.filter((row) => row.from.kind === "here");
	const above = things.filter((row) => row.from.kind !== "here");
	const parties = (people?.rows ?? []).map((row) => ({ ...row, key: partyKey(row.party) }));
	const partyRow = (row: (typeof parties)[number]) => (
		<PartyEntry key={row.key} {...props} from={fromText(row.from)} row={row} workspace={props.workspace} />
	);
	return (
		<div className={styles.groups} data-nav-groups="">
			<Group
				label={t("sessions")}
				name="sessions"
				rows={(children?.rows ?? []).map((child) => (
					<WorkspaceEntry key={child.workspace} {...props} row={child} />
				))}
			/>
			<Group label={t("here")} name="here" rows={here.filter((row) => !row.hidden).map(thingRow)} />
			<Group
				folded={above.filter((row) => row.hidden).map(thingRow)}
				label={t("fromAbove")}
				name="above"
				rows={above.filter((row) => !row.hidden).map(thingRow)}
			/>
			<Group
				folded={parties.filter((row) => row.hidden).map(partyRow)}
				label={t("people")}
				name="people"
				rows={parties.filter((row) => !row.hidden).map(partyRow)}
			/>
		</div>
	);
}

/** One of the open workspace's groups: its rows and the hidden ones folded; left out while it has none. */
function Group(props: {
	readonly label: string;
	readonly name: string;
	readonly rows: readonly ReactNode[];
	readonly folded?: readonly ReactNode[];
}) {
	const folded = props.folded ?? [];
	if (props.rows.length === 0 && folded.length === 0) return null;
	return (
		<SideNavigation.Group data-nav-group={props.name}>
			<SideNavigation.GroupLabel>{props.label}</SideNavigation.GroupLabel>
			<SideNavigation.List>
				{props.rows}
				<Folded rows={folded} />
			</SideNavigation.List>
		</SideNavigation.Group>
	);
}

/** Hidden rows, folded into "N hidden" (none: nothing). */
function Folded(props: { readonly rows: readonly ReactNode[] }) {
	const { t } = useMessages(page);
	if (props.rows.length === 0) return null;
	return (
		<SideNavigation.Item>
			<Collapsible.Root>
				<Collapsible.Trigger className={styles.folded} data-nav-hidden="">
					<ChevronRightIcon />
					{t("hidden", props.rows.length)}
				</Collapsible.Trigger>
				<Collapsible.Panel>
					<SideNavigation.List className={styles.faded}>{props.rows}</SideNavigation.List>
				</Collapsible.Panel>
			</Collapsible.Root>
		</SideNavigation.Item>
	);
}

/** A thing's entry, greyed with its "from" when it comes from above. */
function ThingEntry(
	props: NavigatorProps & {
		readonly workspace: string;
		readonly row: { readonly thing: string; readonly kind: string; readonly name: string };
		readonly from: string | undefined;
	},
) {
	const target: Target = { kind: "thing", workspace: props.workspace, thing: props.row.thing };
	return (
		<SideNavigation.Item className={props.from === undefined ? undefined : styles.faded}>
			<EntryLink
				active={props.target?.kind === "thing" && props.target.thing === props.row.thing}
				data={{ "data-nav-thing": props.row.thing }}
				from={props.from}
				Icon={useKindIcon(props.row.kind)}
				onOpen={props.onOpen}
				target={target}
			>
				{props.row.name}
			</EntryLink>
		</SideNavigation.Item>
	);
}

/** A party's entry (a person or a group), greyed with its "from" when it comes from above. */
function PartyEntry(
	props: NavigatorProps & {
		readonly workspace: string;
		readonly row: { readonly party: Parameters<typeof partyKey>[0]; readonly name: string; readonly key: string };
		readonly from: string | undefined;
	},
) {
	const target = partyTarget(props.workspace, props.row.party);
	if (target === undefined) return null;
	const active =
		(props.target?.kind === "person" && target.kind === "person" && props.target.person === target.person) ||
		(props.target?.kind === "group" && target.kind === "group" && props.target.group === target.group);
	return (
		<SideNavigation.Item className={props.from === undefined ? undefined : styles.faded}>
			<EntryLink
				active={active}
				data={{ "data-nav-party": props.row.key }}
				from={props.from}
				Icon={props.row.party.kind === "group" ? GroupIcon : PersonIcon}
				onOpen={props.onOpen}
				target={target}
			>
				{props.row.name}
			</EntryLink>
		</SideNavigation.Item>
	);
}

/** A link to `target`: a real link (it opens in a new tab too), a plain click asks the chrome to open it. */
function EntryLink(props: {
	readonly target: Target;
	readonly active: boolean;
	readonly Icon: ComponentType;
	readonly from?: string | undefined;
	readonly onOpen: (target: Target) => void;
	readonly data: Readonly<Record<`data-${string}`, string>>;
	readonly children: ReactNode;
}) {
	const { Icon } = props;
	return (
		<SideNavigation.Link
			active={props.active}
			href={targetPath(props.target)}
			iconEnd={props.from === undefined ? undefined : <span className={styles.from}>{props.from}</span>}
			iconStart={<Icon />}
			onClick={(event) => follow(event, () => props.onOpen(props.target))}
			{...props.data}
		>
			{props.children}
		</SideNavigation.Link>
	);
}

/** A plain click runs `open` instead of following the link; a click with a modifier opens the link as the browser does. */
function follow(event: MouseEvent, open: () => void): void {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
	event.preventDefault();
	open();
}

/** A kind's icon (`ThingParts`), else a page. */
function useKindIcon(kind: string): ComponentType {
	return useRegistry(ThingParts)?.get(kind)?.value.Icon ?? DescriptionIcon;
}
