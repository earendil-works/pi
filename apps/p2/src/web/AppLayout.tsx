import { useRef, useState } from "react";
import { closeLayers, Slot, useCanWrite, useDrawer, useRoute, useUnshownLayers } from "../runtime/web.tsx";
import { useComposerState } from "./composer-state.tsx";
import { useDrawerSwipe } from "./drawer-swipe.ts";
import { OwnerNotices } from "./OwnerNotices.tsx";
import { useSidebarCollapsed } from "./sidebar.ts";

export function AppLayout() {
	const drawer = useDrawer(),
		route = useRoute(),
		collapsed = useSidebarCollapsed();
	const canWrite = useCanWrite(route.session);
	const { addFiles } = useComposerState();
	const [draggingFiles, setDraggingFiles] = useState(false);
	const dragDepth = useRef(0);
	const swipe = useDrawerSwipe();
	useUnshownLayers();
	return (
		<div className={`app ${drawer ? "drawer-open" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}>
			<aside className="drawer" ref={swipe.drawer}>
				<Slot name="sidebar" />
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
