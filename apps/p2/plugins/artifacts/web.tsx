import { compile, obj, union } from "@earendil-works/pi-schema";
import { contribute, defineFacet, literal } from "@p2/app/v1";
import {
	ArtifactIcon,
	ArtifactPicker,
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
import { DownloadInfoSchema } from "../files/contract.ts";
import { artifactActivity } from "./activity.tsx";
import { ArtifactInfoSchema, ArtifactList } from "./contract.ts";
import { ArtifactPanel } from "./preview.tsx";

const ViewerSchema = union([
	obj({ kind: literal("file"), file: DownloadInfoSchema }, { open: true }),
	obj({ kind: literal("artifact"), artifact: ArtifactInfoSchema }, { open: true }),
]);
const isViewer = compile(ViewerSchema).check;

/** The side panel's name for the artifact list (`Route.panel`). */
const PANEL = "artifacts";

/** Untrusted URL metadata is only a locator. HTTP routes authorize every content fetch. */
function viewer(overlay: string | undefined): ViewerItem | undefined {
	if (!overlay?.startsWith("viewer:")) return undefined;
	try {
		const value: unknown = JSON.parse(overlay.slice("viewer:".length));
		return isViewer(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function Content({ children }: { children?: ReactNode }) {
	const route = useRoute();
	const list = useObject(
		ArtifactList,
		route.session ? { session: route.session, conversation: route.conversation ?? 1 } : undefined,
	);
	const artifacts = useReadable(list?.artifacts) ?? [];
	const shown = useSidePanelShown();

	const top = route.layers.at(-1);
	const item = viewer(top?.kind === "viewer" && top.name === "artifacts" ? top.locator : undefined);
	const open = (item: ViewerItem): void =>
		openLayer({ kind: "viewer", name: "artifacts", locator: `viewer:${JSON.stringify(item)}` });
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
	});
});
