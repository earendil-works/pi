// Drag and drop in the owner's sidebar: a session's row onto a project's group (or onto the sessions without a
// project) moves it there; a project's row onto another project's moves it before or after that one. With a mouse a
// press becomes a drag once the pointer moved a few pixels, so a click still opens. On touch screens a long press (half
// a second within 8px) picks the row up with a short vibration: moving then drags it (the list does not scroll; near
// its edges it scrolls by itself), letting go without moving opens the row's command menu, as a long press does
// elsewhere. The click a drag or a long press ends with is swallowed. Rows are found by their DOM markers (Sidebar.tsx):
// `li.session-row[data-session]` and its `.session-header`, `li.sidebar-group[data-project]` and its `.group-row`,
// `.sidebar-section.headless`, inside `.sidebar-nav[data-drag]`.
import { type CommandTarget, openCommandMenu } from "@p2/app/v1/web";
import { useEffect, useRef } from "react";
import { projectTarget } from "../project-commands.tsx";

/** What a drop does: a session to a project (null: to none), or a project before another one (null: to the end). */
export type DropActions = {
	readonly onAssign: (session: string, project: string | null) => void;
	readonly onMoveProject: (name: string, before: string | null) => void;
};

/** How far (px) a pressed mouse moves before the press becomes a drag; a picked-up row moves before it drags. */
const THRESHOLD = 5;
/** How long a touch rests before it picks a row up, and how far it may drift meanwhile (as long-press.ts). */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;
/** Within this distance (px) of the list's top or bottom edge a drag scrolls the list, by `EDGE_STEP` per move. */
const EDGE = 48;
const EDGE_STEP = 12;

type Dragged = { readonly kind: "session" | "project"; readonly id: string; readonly label: string };

/** A place a drop lands: its element (highlighted while the pointer is over it) and what the drop does there. */
type Drop = { readonly element: Element; readonly className: string; readonly apply: () => void };

/**
 * A press on a row: where it started, whether it is a touch (picked up only after a long press), whether it was
 * picked up, and whether it moved since (a drag).
 */
type Press = Dragged & {
	readonly touch: boolean;
	readonly x: number;
	readonly y: number;
	readonly scroller: Element | null;
	picked: boolean;
	dragging: boolean;
};

/** Turns on drag and drop in the sidebar navigation `.sidebar-nav[data-drag]` while `actions` is given. */
export function useSidebarDrag(actions: DropActions | undefined): void {
	const current = useRef(actions);
	current.current = actions;
	const enabled = actions !== undefined;
	useEffect(() => {
		if (!enabled) return;
		let press: Press | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let ghost: HTMLElement | undefined;
		let drop: Drop | undefined;
		let swallowClick = false;
		const mark = (next: Drop | undefined) => {
			if (drop) drop.element.classList.remove(drop.className);
			drop = next;
			if (drop) drop.element.classList.add(drop.className);
		};
		const end = () => {
			clearTimeout(timer);
			press = undefined;
			mark(undefined);
			ghost?.remove();
			ghost = undefined;
			document.body.classList.remove("sidebar-dragging");
		};
		const showGhost = (x: number, y: number) => {
			if (!press) return;
			if (!ghost) {
				ghost = document.createElement("div");
				ghost.className = "sidebar-drag-ghost";
				ghost.textContent = press.label;
				document.body.append(ghost);
				document.body.classList.add("sidebar-dragging");
			}
			ghost.style.translate = `${x + 12}px ${y + 8}px`;
		};
		const down = (event: PointerEvent) => {
			if (!(event.target instanceof Element) || !event.isPrimary) return;
			const touch = event.pointerType === "touch";
			if (!touch && (event.pointerType !== "mouse" || event.button !== 0)) return;
			const target = event.target;
			if (!target.closest(".sidebar-nav[data-drag]") || target.closest(".nav-control, .nav-toggle")) return;
			const dragged = draggedAt(target);
			if (!dragged) return;
			const scroller = target.closest(".session-scroll");
			press = { ...dragged, touch, x: event.clientX, y: event.clientY, scroller, picked: !touch, dragging: false };
			if (touch)
				timer = setTimeout(() => {
					if (!press) return;
					press.picked = true;
					navigator.vibrate?.(10);
					showGhost(press.x, press.y);
				}, LONG_PRESS_MS);
		};
		const move = (event: PointerEvent) => {
			if (!press || !event.isPrimary) return;
			const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
			if (!press.picked) {
				// A touch that moves before it was picked up scrolls the list.
				if (moved > LONG_PRESS_SLOP) end();
				return;
			}
			if (!press.dragging && moved < THRESHOLD) return;
			press.dragging = true;
			showGhost(event.clientX, event.clientY);
			if (press.scroller) {
				const box = press.scroller.getBoundingClientRect();
				if (event.clientY < box.top + EDGE) press.scroller.scrollTop -= EDGE_STEP;
				else if (event.clientY > box.bottom - EDGE) press.scroller.scrollTop += EDGE_STEP;
			}
			const under = document.elementFromPoint(event.clientX, event.clientY);
			const actions = current.current;
			mark(under && actions ? dropAt(press, under, event.clientY, actions) : undefined);
		};
		const up = (event: PointerEvent) => {
			if (!press || !event.isPrimary) return;
			if (press.picked && (press.dragging || press.touch)) {
				swallowClick = true;
				// A release on nothing clicks nothing either; the flag goes with the next task.
				setTimeout(() => {
					swallowClick = false;
				}, 0);
				if (press.dragging) drop?.apply();
				else openCommandMenu(targetOf(press));
			}
			end();
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape" && press?.dragging) end();
		};
		const click = (event: MouseEvent) => {
			if (!swallowClick) return;
			event.preventDefault();
			event.stopPropagation();
			swallowClick = false;
		};
		// A picked-up row holds the finger: the list must not scroll, and the touch makes no click of its own.
		const touchMove = (event: TouchEvent) => {
			if (press?.picked) event.preventDefault();
		};
		const touchEnd = (event: TouchEvent) => {
			if (press?.picked || swallowClick) event.preventDefault();
		};
		// Android's long press opens the browser's menu on links; the row's own menu opens instead (or a drag starts).
		const contextMenu = (event: MouseEvent) => {
			if (press?.touch) event.preventDefault();
		};
		// Links are draggable by the browser: its own drag would cancel the pointer's.
		const nativeDrag = (event: DragEvent) => {
			if (event.target instanceof Element && event.target.closest(".sidebar-nav[data-drag]")) event.preventDefault();
		};
		document.addEventListener("pointerdown", down);
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", end);
		window.addEventListener("keydown", key);
		document.addEventListener("click", click, true);
		document.addEventListener("touchmove", touchMove, { passive: false });
		document.addEventListener("touchend", touchEnd, { passive: false });
		document.addEventListener("contextmenu", contextMenu);
		document.addEventListener("dragstart", nativeDrag);
		return () => {
			end();
			document.removeEventListener("pointerdown", down);
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", end);
			window.removeEventListener("keydown", key);
			document.removeEventListener("click", click, true);
			document.removeEventListener("touchmove", touchMove);
			document.removeEventListener("touchend", touchEnd);
			document.removeEventListener("contextmenu", contextMenu);
			document.removeEventListener("dragstart", nativeDrag);
		};
	}, [enabled]);
}

/** The session or project a press at `target` would drag: a session's own row, or a project's row. */
function draggedAt(target: Element): Dragged | undefined {
	const header = target.closest(".session-header");
	const session = header?.closest<HTMLElement>("li.session-row[data-session]");
	if (header && session?.dataset.session)
		return {
			kind: "session",
			id: session.dataset.session,
			label: header.querySelector(".session-title")?.textContent ?? "",
		};
	const project = target.closest(".group-row")?.closest<HTMLElement>("li.sidebar-group[data-project]");
	if (project?.dataset.project !== undefined)
		return { kind: "project", id: project.dataset.project, label: project.dataset.project };
	return undefined;
}

/** The command menu's target of a picked-up row (its long press without a drag opens the menu on it). */
const targetOf = (dragged: Dragged): CommandTarget =>
	dragged.kind === "project"
		? projectTarget(dragged.id)
		: { type: "session", id: dragged.id, kind: "Session", label: dragged.label };

/** Where `dragged` lands over `under` (at height `y`): a project's group, the sessions without one, or between projects. */
function dropAt(dragged: Dragged, under: Element, y: number, actions: DropActions): Drop | undefined {
	const group = under.closest<HTMLElement>("li.sidebar-group[data-project]");
	if (dragged.kind === "session") {
		if (group?.dataset.project !== undefined) {
			const project = group.dataset.project;
			return { element: group, className: "drop-into", apply: () => actions.onAssign(dragged.id, project) };
		}
		const free = under.closest(".sidebar-section.headless");
		return free
			? { element: free, className: "drop-into", apply: () => actions.onAssign(dragged.id, null) }
			: undefined;
	}
	if (group?.dataset.project === undefined || group.dataset.project === dragged.id) return undefined;
	const name = group.dataset.project;
	const row = group.querySelector(".group-row") ?? group;
	const box = row.getBoundingClientRect();
	if (y < box.top + box.height / 2)
		return { element: group, className: "drop-before", apply: () => actions.onMoveProject(dragged.id, name) };
	const next = projectAfter(group);
	const before = next === dragged.id ? (projectAfter(group.nextElementSibling) ?? null) : (next ?? null);
	return { element: group, className: "drop-after", apply: () => actions.onMoveProject(dragged.id, before) };
}

/** The project of the group after `element` in the list, if any. */
const projectAfter = (element: Element | null): string | undefined =>
	element?.nextElementSibling?.closest<HTMLElement>("li.sidebar-group[data-project]")?.dataset.project;
