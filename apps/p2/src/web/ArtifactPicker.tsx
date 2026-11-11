// A conversation's artifacts, every version newest first, in the side panel (docked on the right, a sheet on phones).
import type { ArtifactInfo } from "../runtime/schemas.ts";
import { inPage } from "./navigation.ts";
import { SidePanel } from "./SidePanel.tsx";

/**
 * Lists `artifacts` in the side panel; a row opens that version, and is a link to `href` of it, so it also opens in
 * another tab.
 */
export function ArtifactPicker({
	artifacts,
	href,
	onOpen,
	onClose,
}: {
	artifacts: ArtifactInfo[];
	href: (artifact: ArtifactInfo) => string;
	onOpen: (artifact: ArtifactInfo) => void;
	onClose: () => void;
}) {
	return (
		<SidePanel title="Artifacts" onClose={onClose} testId="artifact-panel">
			{artifacts.length ? (
				<div className="artifact-list">
					{artifacts.map((artifact) => (
						<a
							className="artifact-row"
							key={`${artifact.name}:${artifact.version}`}
							href={href(artifact)}
							onClick={inPage(() => onOpen(artifact))}
						>
							<span>
								<strong>{artifact.title}</strong>
								<small>{artifact.name}</small>
							</span>
							<small>
								{artifact.type} · v{artifact.version}
							</small>
						</a>
					))}
				</div>
			) : (
				<p className="empty-note">No artifacts in this conversation.</p>
			)}
		</SidePanel>
	);
}
