// The right-hand side panel: docked beside the chat on wide screens (`#side-dock` in AppLayout), p2's sheet on phones.
// The route names what it shows, one thing at a time: a transcript block's activity (`activity`) or a plugin's panel
// (`panel`). It is not modal: on wide screens the chat stays usable and sheets or viewers open above it.
import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getNavigation, Sheet, useRoute, useScrollMemory } from "../runtime/web.tsx";
import { useDragSize } from "./drag-size.ts";
import { CloseIcon } from "./icons.tsx";
import type { Route } from "./navigation.ts";

/** Where the panel docks instead of being a sheet. */
const WIDE = "(min-width: 700px)";

const wideSnapshot = () => window.matchMedia(WIDE).matches;
const subscribeWidth = (changed: () => void) => {
	const media = window.matchMedia(WIDE);
	media.addEventListener("change", changed);
	return () => media.removeEventListener("change", changed);
};

/** Whether the side panel docks (wide screens) rather than opening as a sheet (phones). */
export function useWide(): boolean {
	return useSyncExternalStore(subscribeWidth, wideSnapshot);
}

/**
 * Whether the side panel may show what the route names: not while the workspace panel is open (it takes the same
 * place), and on phones not while a sheet or viewer is above it (Back shows it again).
 */
export function useSidePanelShown(): boolean {
	const route = useRoute();
	const wide = useWide();
	return !route.workspace && (wide || !route.layers.length);
}

/**
 * Shows `change` in the side panel instead of what it showed. Switching what an open panel shows is a selection, not a
 * growing stack of panels to close: it replaces the step; opening the panel is a new one, so Back closes it.
 */
export function showInSidePanel(change: Pick<Route, "activity" | "panel">): void {
	const nav = getNavigation();
	const next = { ...nav.route, workspace: undefined, activity: undefined, panel: undefined, ...change };
	if ((nav.route.activity || nav.route.panel) && !nav.route.workspace) void nav.replace(next);
	else void nav.push(next);
}

/** Opens the plugin panel `name` in the side panel. */
export function openPanel(name: string): void {
	showInSidePanel({ panel: name });
}

/** Closes a plugin panel, returning to the screen beneath it. */
export function closePanel(): void {
	void getNavigation().close((route) => ({ ...route, panel: undefined }));
}

/**
 * The side panel's frame: a header with `title`, `meta` at its right and Close, then `children` in a scrolling body.
 * Docked, dragging its left edge resizes it (one width for every side panel, kept per browser). Escape closes it while
 * no sheet or viewer is above it. On phones it is p2's Sheet, titled `sheetTitle` (default `title`): the sheet's header
 * has room for one heading.
 */
export function SidePanel({
	title,
	sheetTitle = title,
	meta,
	onClose,
	className,
	testId,
	children,
}: {
	title: string;
	sheetTitle?: string;
	meta?: string;
	onClose: () => void;
	className?: string;
	testId?: string;
	children: ReactNode;
}) {
	const wide = useWide();
	if (!wide)
		return (
			<Sheet
				title={sheetTitle}
				onClose={onClose}
				{...(className ? { className } : {})}
				{...(testId ? { testId } : {})}
			>
				{children}
			</Sheet>
		);
	const dock = document.getElementById("side-dock");
	return dock
		? createPortal(
				<DockedPanel title={title} meta={meta} onClose={onClose} className={className} testId={testId}>
					{children}
				</DockedPanel>,
				dock,
			)
		: null;
}

function DockedPanel({
	title,
	meta,
	onClose,
	className,
	testId,
	children,
}: {
	title: string;
	meta: string | undefined;
	onClose: () => void;
	className: string | undefined;
	testId: string | undefined;
	children: ReactNode;
}) {
	const panel = useRef<HTMLElement>(null);
	const body = useRef<HTMLDivElement>(null);
	useScrollMemory(body);
	const width = useDragSize("p2-side-panel-width", "--side-panel-width");
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			// A sheet or viewer above the panel takes Escape first.
			if (event.key !== "Escape" || event.defaultPrevented || getNavigation().route.layers.length) return;
			event.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);
	return (
		<aside
			className={`side-panel ${className ?? ""}`}
			aria-label={title}
			data-testid={testId}
			ref={panel}
			style={width.style}
		>
			<button
				type="button"
				className="side-panel-resize"
				aria-label="Drag to resize panel"
				tabIndex={-1}
				onPointerDown={(event) => {
					const element = panel.current;
					if (!element) return;
					const right = element.getBoundingClientRect().right;
					width.drag(event, element, (moved) =>
						Math.min(Math.max(right - moved.clientX, 320), window.innerWidth * 0.7),
					);
				}}
			/>
			<header className="side-panel-head sheet-head">
				<h2>{title}</h2>
				{meta && <span className="side-panel-meta">{meta}</span>}
				<button type="button" className="icon-button" onClick={onClose} aria-label="Close">
					<CloseIcon />
				</button>
			</header>
			<div className="side-panel-body" ref={body}>
				{children}
			</div>
		</aside>
	);
}
