// Artifacts in the browser: the viewer over the chat (viewer.ts), the artifact list in the side panel and its top bar
// button, the tool's card, and the artifact commands of the command menu (commands.tsx).
import { contribute, defineFacet } from "@p2/app/v1";
import {
	ArtifactIcon,
	ArtifactPicker,
	CommandPages,
	CommandSearches,
	Commands,
	closeLayers,
	closePanel,
	FilePanel,
	OpenViewer,
	openLayer,
	openPanel,
	SessionId,
	Slots,
	ToolActivities,
	useObject,
	useReadable,
	useRoute,
	useSidePanelShown,
	type ViewerItem,
} from "@p2/app/v1/web";
import type { ReactNode } from "react";
import { artifactActivity } from "./activity.tsx";
import { ARTIFACT_COMMANDS, ARTIFACT_PAGES, ARTIFACT_SEARCH } from "./commands.tsx";
import { ArtifactList } from "./contract.ts";
import { ArtifactPanel } from "./preview.tsx";
import { viewerItem, viewerLayer } from "./viewer.ts";

/** The side panel's name for the artifact list (`Route.panel`). */
const PANEL = "artifacts";

function Content({ children }: { children?: ReactNode }) {
	const route = useRoute();
	const list = useObject(
		ArtifactList,
		route.session ? { session: route.session, conversation: route.conversation ?? 1 } : undefined,
	);
	const artifacts = useReadable(list?.artifacts) ?? [];
	const shown = useSidePanelShown();

	const top = route.layers.at(-1);
	const item = viewerItem(top);
	const open = (item: ViewerItem): void => openLayer(viewerLayer(item));
	return (
		<SessionId.Provider value={route.session}>
			<OpenViewer.Provider value={open}>
				{children}
				{route.panel === PANEL && shown && (
					<ArtifactPicker
						artifacts={artifacts.toReversed()}
						onOpen={(artifact) => open({ kind: "artifact", artifact })}
						onClose={closePanel}
					/>
				)}

				{route.session &&
					item &&
					(item.kind === "artifact" ? (
						<ArtifactPanel
							key={top?.kind !== "drawer" ? top?.locator : undefined}
							sessionId={route.session}
							artifact={item.artifact}
							onClose={closeLayers}
						/>
					) : (
						<FilePanel
							key={top?.kind !== "drawer" ? top?.locator : undefined}
							sessionId={route.session}
							file={item.file}
							onClose={closeLayers}
						/>
					))}
			</OpenViewer.Provider>
		</SessionId.Provider>
	);
}

function ArtifactButton() {
	const route = useRoute();
	const list = useObject(
		ArtifactList,
		route.session ? { session: route.session, conversation: route.conversation ?? 1 } : undefined,
	);
	const artifacts = useReadable(list?.artifacts) ?? [];
	const count = artifacts.length;
	if (!count) return null;
	const open = route.panel === PANEL;
	return (
		<button
			type="button"
			className={`artifact-button ${open ? "on" : ""}`}
			aria-label={`Artifacts (${count})`}
			aria-pressed={open}
			onClick={() => (open ? closePanel() : openPanel(PANEL))}
		>
			<ArtifactIcon />
			<span>{count}</span>
		</button>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-artifacts", (self) => {
		self.contribute(Slots, { "chat-content": Content, "artifact-actions": ArtifactButton });
		self.contribute(ToolActivities, { artifact: artifactActivity });
		self.contribute(Commands, ARTIFACT_COMMANDS);
		self.contribute(CommandPages, ARTIFACT_PAGES);
		self.contribute(CommandSearches, { artifacts: ARTIFACT_SEARCH });
	});
});
