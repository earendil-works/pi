// `/tree` in the browser (docs/tree.md, "Tree panel"): the top bar's button opening the tree panel in the side panel,
// beside the terminal's and the workspace's, and the panel itself (TreePanel.tsx). The owner's only: the tree is.
import { contribute, defineFacet } from "@p2/app/v1";
import { BranchIcon, closePanel, openPanel, Slots, useOwner, useRoute, useSidePanelShown } from "@p2/app/v1/web";
import { TREE_PANEL, TreePanel } from "./TreePanel.tsx";

/** Shows or hides the tree panel. */
function TreeButton() {
	const route = useRoute();
	const owner = useOwner();
	if (!owner || !route.session) return null;
	// The workspace panel takes the side panel's place: while it is open the tree panel is not shown.
	const open = route.panel === TREE_PANEL && !route.workspace;
	return (
		<button
			type="button"
			className={`icon-button workspace-toggle ${open ? "on" : ""}`}
			aria-label="Conversation tree"
			aria-pressed={open}
			onClick={() => (open ? closePanel() : openPanel(TREE_PANEL))}
		>
			<BranchIcon size={20} />
		</button>
	);
}

/** The tree panel while the route names it and the side panel may show. */
function TreeOverlay() {
	const route = useRoute();
	const owner = useOwner();
	const shown = useSidePanelShown();
	if (!owner || !route.session || route.panel !== TREE_PANEL || !shown) return null;
	return <TreePanel key={route.session} session={route.session} />;
}

export default defineFacet((host) => {
	contribute(host, "p2.web-tree", (self) => {
		self.contribute(Slots, { "tree-actions": TreeButton, "overlay:tree": TreeOverlay });
	});
});
