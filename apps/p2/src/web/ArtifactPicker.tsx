import type { ArtifactInfo } from "../runtime/schemas.ts";
import { Sheet } from "../runtime/web.tsx";
export function ArtifactPicker({
	artifacts,
	onOpen,
	onClose,
}: {
	artifacts: ArtifactInfo[];
	onOpen: (artifact: ArtifactInfo) => void;
	onClose: () => void;
}) {
	return (
		<Sheet title="Artifacts" onClose={onClose}>
			{artifacts.length ? (
				<div className="artifact-list">
					{artifacts.map((artifact) => (
						<button
							type="button"
							className="artifact-row"
							key={`${artifact.name}:${artifact.version}`}
							onClick={() => onOpen(artifact)}
						>
							<span>
								<strong>{artifact.title}</strong>
								<small>{artifact.name}</small>
							</span>
							<small>
								{artifact.type} · v{artifact.version}
							</small>
						</button>
					))}
				</div>
			) : (
				<p className="empty-note">No artifacts in this conversation.</p>
			)}
		</Sheet>
	);
}
