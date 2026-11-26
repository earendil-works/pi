// The pane layout from 48rem (`PaneLayout`): the tree's splits side by side or stacked, each divider dragged (pointer)
// or stepped (arrow keys) to resize; each group a tab bar over its active pane. A tab is dragged with the pointer
// (pointer events: mouse, pen and touch alike): within its bar to reorder, onto another group's bar to move there, onto
// a group's body near an edge to split that group on that side, onto its middle to move into it; the drop's place is
// shown while dragging, Escape cancels. A click on a tab shows it.

import { CloseIcon, useMessages } from "@earendil-works/p3/v1/web";
import { Fragment, type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { Pane, PaneLayoutProps } from "./contract.web.tsx";
import { messages } from "./messages.ts";
import { closeShownPane, showPane } from "./pane-layout.tsx";
import styles from "./pane-splits.module.css";
import {
	groupOf,
	groupsOf,
	movePane,
	type PaneEdge,
	type PaneGroup,
	type PaneNode,
	type PaneSplit,
	resizeSplit,
	splitPane,
} from "./tree.ts";

/** Where a dragged tab would drop: into a group's tab bar at an index, or on its body's edge or middle. */
type DropTarget =
	| { readonly kind: "tabs"; readonly group: string; readonly index: number }
	| { readonly kind: "body"; readonly group: string; readonly edge: PaneEdge | "center" };

/** A tab being dragged: its pane, where the pointer is, and where it would drop. */
type Drag = { readonly pane: string; readonly x: number; readonly y: number; readonly target: DropTarget | undefined };

/** What every node of the layout reads: the layout's props, its panes by id, the drag, and how to start one. */
type Shared = {
	readonly props: PaneLayoutProps;
	readonly panes: ReadonlyMap<string, Pane>;
	readonly drag: Drag | undefined;
	readonly startDrag: (pane: string, event: ReactPointerEvent) => void;
	readonly click: (pane: string) => void;
	readonly latest: { readonly current: PaneLayoutProps };
};

/** The split form of the layout. */
export function PaneSplits(props: PaneLayoutProps) {
	const [drag, setDrag] = useState<Drag | undefined>(undefined);
	const latest = useRef(props);
	latest.current = props;
	// A pointer that dragged a tab ends with a click on it, which must not also show it.
	const dragged = useRef(false);
	const startDrag = (pane: string, event: ReactPointerEvent) => {
		if (event.button !== 0) return;
		const { pointerId, clientX, clientY } = event;
		let moved = false;
		let target: DropTarget | undefined;
		const move = (next: PointerEvent) => {
			if (next.pointerId !== pointerId) return;
			if (!moved && Math.hypot(next.clientX - clientX, next.clientY - clientY) < DRAG_START) return;
			moved = true;
			dragged.current = true;
			target = dropTargetAt(next.clientX, next.clientY);
			setDrag({ pane, x: next.clientX, y: next.clientY, target });
		};
		const stop = () => {
			removeEventListener("pointermove", move, true);
			removeEventListener("pointerup", up, true);
			removeEventListener("pointercancel", stop, true);
			removeEventListener("keydown", cancelled, true);
			setDrag(undefined);
			// The click that follows a drag's release (if any) comes before this turn ends.
			setTimeout(() => {
				dragged.current = false;
			});
		};
		const up = (next: PointerEvent) => {
			if (next.pointerId !== pointerId) return;
			stop();
			if (moved && target !== undefined) drop(latest.current, pane, target);
		};
		const cancelled = (next: KeyboardEvent) => {
			if (next.key === "Escape") stop();
		};
		// Captured at the window: a pane's own handlers (a canvas drawing) may stop the pointer's events bubbling.
		addEventListener("pointermove", move, true);
		addEventListener("pointerup", up, true);
		addEventListener("pointercancel", stop, true);
		addEventListener("keydown", cancelled, true);
	};
	const shared: Shared = {
		props,
		panes: new Map(props.panes.map((pane) => [pane.id, pane])),
		drag,
		startDrag,
		click: (pane) => {
			if (!dragged.current) showPane(latest.current, pane);
		},
		latest,
	};
	return (
		<div className={styles.layout} data-dragging={drag === undefined ? undefined : ""} data-pane-layout="split">
			<NodeView node={props.tree} path={[]} shared={shared} />
			{drag === undefined ? null : (
				<div className={styles.ghost} style={{ left: drag.x + 12, top: drag.y + 12 }}>
					{shared.panes.get(drag.pane)?.title ?? drag.pane}
				</div>
			)}
		</div>
	);
}

/** How far (px) a pointer moves on a tab before it drags it. */
const DRAG_START = 6;

/** How close to a body's edge (a share of its size) a drop splits there. */
const EDGE = 0.25;

/** The drop target under the point (`x`, `y`), if any (the ghost lets the pointer through). */
function dropTargetAt(x: number, y: number): DropTarget | undefined {
	const element = document.elementFromPoint(x, y);
	const group = element?.closest<HTMLElement>("[data-pane-group]");
	const id = group?.dataset.paneGroup;
	if (element === null || group === null || group === undefined || id === undefined) return undefined;
	const bar = element.closest("[data-pane-tabs]");
	if (bar !== null) {
		const tabs = [...bar.querySelectorAll("[data-pane-tab]")];
		const index = tabs.findIndex((tab) => {
			const box = tab.getBoundingClientRect();
			return x < box.left + box.width / 2;
		});
		return { kind: "tabs", group: id, index: index === -1 ? tabs.length : index };
	}
	const body = group.querySelector("[data-pane-body]")?.getBoundingClientRect();
	if (body === undefined) return undefined;
	const across = (x - body.left) / body.width;
	const down = (y - body.top) / body.height;
	const edges: readonly (readonly [PaneEdge, number])[] = [
		["left", across],
		["right", 1 - across],
		["top", down],
		["bottom", 1 - down],
	];
	const [edge, distance] = [...edges].sort((a, b) => a[1] - b[1])[0]!;
	return { kind: "body", group: id, edge: distance < EDGE ? edge : "center" };
}

/** Drops `pane` on `target`: moves it, or splits the target's group; the pane is shown and focused. */
function drop(props: PaneLayoutProps, pane: string, target: DropTarget): void {
	const { tree } = props;
	let next: PaneNode;
	if (target.kind === "tabs") next = movePane(tree, pane, target.group, target.index);
	else if (target.edge !== "center") next = splitPane(tree, pane, target.group, target.edge);
	else if (groupOf(tree, pane)?.id === target.group) return;
	else {
		const tabs = groupsOf(tree).find((group) => group.id === target.group)?.tabs.length ?? 0;
		next = movePane(tree, pane, target.group, tabs);
	}
	props.onChange(next);
	props.onFocus(pane);
}

/** A node of the tree: a split, or a group. */
function NodeView(props: { readonly node: PaneNode; readonly path: readonly number[]; readonly shared: Shared }) {
	const { node } = props;
	return node.kind === "group" ? (
		<GroupView group={node} shared={props.shared} />
	) : (
		<SplitView path={props.path} shared={props.shared} split={node} />
	);
}

/** A split: its children with their shares, a divider between each two. */
function SplitView(props: { readonly split: PaneSplit; readonly path: readonly number[]; readonly shared: Shared }) {
	const { split, path } = props;
	return (
		<div className={styles.split} data-direction={split.direction}>
			{split.children.map((child, index) => (
				// A child keeps its identity by its first group while the tree around it changes.
				<Fragment key={groupsOf(child)[0]?.id ?? index}>
					{index === 0 ? null : <Divider index={index - 1} path={path} shared={props.shared} split={split} />}
					<div
						className={styles.cell}
						data-share={split.sizes[index]!.toFixed(3)}
						style={{ flexGrow: split.sizes[index] }}
					>
						<NodeView node={child} path={[...path, index]} shared={props.shared} />
					</div>
				</Fragment>
			))}
		</div>
	);
}

/** How far an arrow key moves a divider: a share of its split's size. */
const KEY_STEP = 0.05;

/** The divider after child `index` of `split` (at `path`): dragged or stepped with the arrow keys. */
function Divider(props: {
	readonly split: PaneSplit;
	readonly path: readonly number[];
	readonly index: number;
	readonly shared: Shared;
}) {
	const { split, path, index, shared } = props;
	const { t } = useMessages(messages);
	const row = split.direction === "row";
	const resize = (delta: number) => {
		const latest = shared.latest.current;
		latest.onChange(resizeSplit(latest.tree, path, index, delta));
	};
	const start = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const container = event.currentTarget.parentElement?.getBoundingClientRect();
		if (container === undefined) return;
		const size = row ? container.width : container.height;
		const from = row ? event.clientX : event.clientY;
		const base = shared.latest.current.tree;
		const { pointerId } = event;
		const move = (next: PointerEvent) => {
			if (next.pointerId !== pointerId) return;
			const delta = ((row ? next.clientX : next.clientY) - from) / size;
			shared.latest.current.onChange(resizeSplit(base, path, index, delta));
		};
		const stop = (next: PointerEvent) => {
			if (next.pointerId !== pointerId) return;
			removeEventListener("pointermove", move, true);
			removeEventListener("pointerup", stop, true);
			removeEventListener("pointercancel", stop, true);
		};
		addEventListener("pointermove", move, true);
		addEventListener("pointerup", stop, true);
		addEventListener("pointercancel", stop, true);
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter; <hr> takes no focus.
		<div
			aria-label={t("resize")}
			aria-orientation={row ? "vertical" : "horizontal"}
			aria-valuemax={90}
			aria-valuemin={10}
			aria-valuenow={Math.round(split.sizes[index]! * 100)}
			className={styles.divider}
			data-direction={split.direction}
			data-pane-divider={[...path, index].join(".")}
			onKeyDown={(event) => {
				const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
				if (step === undefined) return;
				event.preventDefault();
				resize(step * KEY_STEP);
			}}
			onPointerDown={start}
			role="separator"
			tabIndex={0}
		/>
	);
}

/** A group: its tab bar (with the drop's place while a tab is dragged over it) and its active pane. */
function GroupView(props: { readonly group: PaneGroup; readonly shared: Shared }) {
	const { group, shared } = props;
	const { t } = useMessages(messages);
	const target = shared.drag?.target?.group === group.id ? shared.drag.target : undefined;
	const insertAt = target?.kind === "tabs" ? target.index : undefined;
	const active = group.active === null ? undefined : shared.panes.get(group.active);
	const focused = shared.props.focused !== undefined && group.tabs.includes(shared.props.focused);
	const insert = <span className={styles.insert} data-pane-insert="" />;
	return (
		<section className={styles.group} data-focused={focused ? "" : undefined} data-pane-group={group.id}>
			<div className={styles.tabs} data-pane-tabs="" role="tablist">
				{group.tabs.map((id, index) => {
					const pane = shared.panes.get(id);
					if (pane === undefined) return null;
					return (
						<Fragment key={id}>
							{insertAt === index ? insert : null}
							<span className={styles.tab} data-active={id === group.active ? "" : undefined} data-pane-tab={id}>
								<button
									aria-selected={id === group.active}
									className={styles.tabButton}
									onClick={() => shared.click(id)}
									onPointerDown={(event) => shared.startDrag(id, event)}
									role="tab"
									type="button"
								>
									{pane.title}
								</button>
								{pane.closable ? (
									<button
										aria-label={t("close", pane.title)}
										className={styles.close}
										data-pane-close={id}
										onClick={() => closeShownPane(shared.latest.current, id)}
										type="button"
									>
										<CloseIcon />
									</button>
								) : null}
							</span>
						</Fragment>
					);
				})}
				{insertAt !== undefined && insertAt >= group.tabs.length ? insert : null}
			</div>
			<div className={styles.body} data-pane={active?.id} data-pane-body="">
				{active === undefined ? null : <Fragment key={active.id}>{active.render()}</Fragment>}
				{target?.kind === "body" ? <div className={styles.drop} data-drop={target.edge} /> : null}
			</div>
		</section>
	);
}
