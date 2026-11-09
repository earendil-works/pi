import { type CSSProperties, type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { closeLayers, Slot, useCanWrite, useDrawer, useRoute, useUnshownLayers } from "../runtime/web.tsx";
import { useComposerState } from "./composer-state.tsx";
import { useDrawerSwipe } from "./drawer-swipe.ts";
import { OwnerNotices } from "./OwnerNotices.tsx";
import { useSidebarCollapsed } from "./sidebar.ts";

const WIDTH_KEY = "pi-sidebar-width";

export function AppLayout() {
	const drawer = useDrawer(),
		route = useRoute(),
		collapsed = useSidebarCollapsed();
	const canWrite = useCanWrite(route.session);
	const { addFiles } = useComposerState();
	const [draggingFiles, setDraggingFiles] = useState(false);
	const dragDepth = useRef(0);
	const swipe = useDrawerSwipe();
	// Docked width (from 900px), dragged at the inline end and remembered per browser; the phone drawer ignores it.
	const [width, setWidth] = useState(() => {
		try {
			return Number(localStorage.getItem(WIDTH_KEY)) || undefined;
		} catch {
			return undefined;
		}
	});
	// The handle captures its pointer, so the drag goes on off the handle. During the drag only the CSS variable
	// changes; React renders the layout once at the end.
	const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
		const element = event.currentTarget.parentElement;
		if (!element || (event.pointerType === "mouse" && event.button !== 0)) return;
		event.preventDefault();
		const handle = event.currentTarget;
		const pointer = event.pointerId;
		handle.setPointerCapture(pointer);
		const box = element.getBoundingClientRect();
		const rtl = getComputedStyle(element).direction === "rtl";
		let last = width;
		const move = (moved: PointerEvent) => {
			if (moved.pointerId !== pointer) return;
			const dragged = rtl ? box.right - moved.clientX : moved.clientX - box.left;
			last = Math.round(Math.min(Math.max(dragged, 220), Math.min(560, window.innerWidth * 0.5)));
			element.style.setProperty("--sidebar-width", `${last}px`);
		};
		const end = (ended: PointerEvent) => {
			if (ended.pointerId !== pointer) return;
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			if (!last) return;
			setWidth(last);
			try {
				localStorage.setItem(WIDTH_KEY, String(last));
			} catch {}
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};
	useUnshownLayers();
	return (
		<div className={`app ${drawer ? "drawer-open" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}>
			<aside
				className="drawer"
				ref={swipe.drawer}
				style={width ? ({ "--sidebar-width": `${width}px` } as CSSProperties) : undefined}
			>
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
				className={`main ${draggingFiles ? "dragging-files" : ""} ${route.session ? "" : "new-session-view"}`}
				onDragEnter={(event) => {
					if (!canWrite || ![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
					event.preventDefault();
					dragDepth.current++;
					setDraggingFiles(true);
				}}
				onDragOver={(event) => {
					if (!canWrite || ![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
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
					if (!canWrite) return;
					event.preventDefault();
					dragDepth.current = 0;
					setDraggingFiles(false);
					addFiles([...event.dataTransfer.files]);
					document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
				}}
			>
				{draggingFiles && <div className="drop-overlay">Drop files to attach</div>}
				<OwnerNotices />
				<Slot name="main" fallback={<div className="hero">No chat plugin</div>} />
			</main>
			<div id="side-dock" className="side-dock" />
			<Slot name="workspace-panel" />
		</div>
	);
}
