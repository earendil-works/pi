// Where a turn's steps open: a bottom sheet on a phone; on a wider screen (from 900px, like the workspace) a panel at
// the right, a column over the chat, docked beside it from 1280px. The panel takes the workspace panel's place:
// opening one closes the other. Either way a stack of pages inside (Elanor's Drawer.Stack, for now ../elanor-extra).

import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { useNavigation, useRoute } from "../../runtime/web.tsx";
import { Drawer } from "../elanor-extra/drawer.tsx";

const WIDE = "(min-width: 900px)";
/** The element the docked panel renders into (AppLayout). */
export const DOCK_ID = "side-dock";

function subscribe(onChange: () => void) {
	const query = window.matchMedia(WIDE);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** Whether the steps open in the docked panel: the screen is wide. */
export const useDocked = () =>
	useSyncExternalStore(
		subscribe,
		() => window.matchMedia(WIDE).matches,
		() => false,
	);

export function Sheet({
	open,
	onOpenChange,
	onBack,
	testId,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Pops the top page. */
	onBack: () => void;
	testId: string;
	/** Drawer.Page elements, bottom first. */
	children: ReactNode;
}) {
	const docked = useDocked();
	const route = useRoute();
	const nav = useNavigation();
	// The panel and the workspace share the right: the panel opening closes the workspace, the workspace opening the
	// panel.
	const workspace = Boolean(route.workspace);
	// Only when the panel opens (the workspace opening is the effect below).
	// biome-ignore lint/correctness/useExhaustiveDependencies: nav and workspace are read, not watched.
	useEffect(() => {
		if (docked && open && workspace) void nav.close((current) => ({ ...current, workspace: undefined }));
	}, [docked, open]);
	// Only when the workspace opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: docked and onOpenChange are read, not watched.
	useEffect(() => {
		if (docked && workspace) onOpenChange(false);
	}, [workspace]);
	if (docked) {
		const container = typeof document === "undefined" ? null : document.getElementById(DOCK_ID);
		return (
			<Drawer.Root
				open={open}
				onOpenChange={onOpenChange}
				swipeDirection="right"
				modal={false}
				disablePointerDismissal
			>
				<Drawer.Portal container={container}>
					<Drawer.Popup className="activity-panel activity-pages" data-testid={testId}>
						{/* Docked beside the chat, pages crossfade: sliding them and swiping back are a phone's. */}
						<Drawer.Stack onBack={onBack} transition="fade">
							{children}
						</Drawer.Stack>
					</Drawer.Popup>
				</Drawer.Portal>
			</Drawer.Root>
		);
	}
	return (
		<Drawer.Root open={open} onOpenChange={onOpenChange}>
			<Drawer.Portal>
				<Drawer.Backdrop className="activity-sheet-layer" />
				<Drawer.Viewport className="activity-sheet-layer">
					<Drawer.Popup className="activity-sheet activity-pages" data-testid={testId}>
						<Drawer.Stack onBack={onBack}>{children}</Drawer.Stack>
					</Drawer.Popup>
				</Drawer.Viewport>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
