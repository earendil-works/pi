// Showing the workspace on one of its tabs: for its button in the top bar, its tab buttons and the command menu.
import type { Navigation, Route, WorkspaceRoute, WorkspaceTab } from "@p2/app/v1/web";

/** `route` with its session's workspace open on `tab`, at the working tree's root. */
export const withWorkspace = (route: Route, tab: WorkspaceTab): Route => ({
	...route,
	workspace: { tab, directory: "" },
});

/**
 * Shows the route's workspace on `tab`. Tabs are lateral: switching returns to where the panel opened, keeping each
 * tab's folder and search but dropping files and commits visited meanwhile. A closed workspace opens on it, as a step.
 */
export function showWorkspaceTab(nav: Navigation, tab: WorkspaceTab): void {
	const current = nav.route.workspace;
	if (!current) {
		void nav.push(withWorkspace(nav.route, tab));
		return;
	}
	const target: WorkspaceRoute = {
		tab,
		directory: current.directory,
		...(current.search ? { search: current.search } : {}),
		...(current.terminal ? { terminal: current.terminal } : {}),
		...(tab === "terminal" ? { startTerminal: true } : {}),
	};
	void nav.reset(
		(entry) => entry.workspace !== undefined && entry.layers.length === 0,
		(landed) => ({ ...landed, workspace: target }),
	);
}
