import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { closeLayers, Slot, useCanWrite, useDrawer, useRoute, useUnshownLayers } from "../runtime/web.tsx";
import { useComposerState } from "./composer-state.tsx";
import { useDragSize } from "./drag-size.ts";
import { useDrawerSwipe } from "./drawer-swipe.ts";
import { OwnerNotices } from "./OwnerNotices.tsx";
import { SettingsSectionSheets } from "./SettingsNav.tsx";
import { useSidebarCollapsed } from "./sidebar.ts";

export function AppLayout() {
	const drawer = useDrawer(),
		route = useRoute(),
		collapsed = useSidebarCollapsed();
	// Files dropped go to the composer: a list page (`Route.page`) has none.
	const canDrop = useCanWrite(route.session) && route.page === undefined;
	const { addFiles } = useComposerState();
	const [draggingFiles, setDraggingFiles] = useState(false);
	const dragDepth = useRef(0);
	const swipe = useDrawerSwipe();
	// Docked width (from 900px), dragged at the inline end and remembered per browser; the phone drawer ignores it.
	const width = useDragSize("pi-sidebar-width", "--sidebar-width");
	const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const element = event.currentTarget.parentElement;
		if (!element) return;
		const box = element.getBoundingClientRect();
		const rtl = getComputedStyle(element).direction === "rtl";
		width.drag(event, element, (moved) =>
			Math.min(
				Math.max(rtl ? box.right - moved.clientX : moved.clientX - box.left, 220),
				Math.min(560, window.innerWidth * 0.5),
			),
		);
	};
	useUnshownLayers();
	return (
		<div className={`app ${drawer ? "drawer-open" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}>
			<aside className="drawer" ref={swipe.drawer} style={width.style}>
				<Slot name="sidebar" />
				<button
					type="button"
					className="sidebar-resize"
					aria-label="Drag to resize sidebar"
					tabIndex={-1}
					onPointerDown={startResize}
				/>
			</aside>
			<button
				type="button"
				className="drawer-scrim"
				ref={swipe.scrim}
				aria-label="Close sessions"
				onClick={closeLayers}
				tabIndex={drawer ? 0 : -1}
			/>
			<main
				ref={swipe.main}
				className={`main ${draggingFiles ? "dragging-files" : ""} ${route.session || route.page !== undefined ? "" : "new-session-view"}`}
				onDragEnter={(event) => {
					if (!canDrop || ![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
					event.preventDefault();
					dragDepth.current++;
					setDraggingFiles(true);
				}}
				onDragOver={(event) => {
					if (!canDrop || ![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
				}}
				onDragLeave={(event) => {
					if (!draggingFiles) return;
					event.preventDefault();
					dragDepth.current = Math.max(0, dragDepth.current - 1);
					if (dragDepth.current === 0) setDraggingFiles(false);
				}}
				onDrop={(event) => {
					if (!canDrop) return;
					event.preventDefault();
					dragDepth.current = 0;
					setDraggingFiles(false);
					addFiles([...event.dataTransfer.files]);
					document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
				}}
			>
				{draggingFiles && <div className="drop-overlay">Drop files to attach</div>}
				{/* The chat (with the owner's notices below its top bar), as the workbench's first pane when a plugin lays
				    out panes beside it (views); a sidebar rollup's or group's list (`Route.page`, the sessions plugin's)
				    instead of the chat. */}
				<Slot name="workbench">
					<OwnerNotices />
					{route.page !== undefined ? (
						<Slot name="page" fallback={<div className="hero">No list pages</div>} />
					) : (
						<Slot name="main" fallback={<div className="hero">No chat plugin</div>} />
					)}
				</Slot>
			</main>
			<div id="side-dock" className="side-dock" />
			<Slot name="workspace-panel" />
			<SettingsSectionSheets />
		</div>
	);
}
