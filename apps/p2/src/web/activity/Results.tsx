// What a turn made for the person, after its answer: artifacts and sent files as cards that open the viewer (and an
// artifact the agent asked to show inline, below its card), opened ports as links. The same calls are in the turn's
// timeline too.
import { useContext } from "react";
import { SessionId } from "../chat-context.ts";
import type { ToolView } from "../transcript.ts";
import { artifactUrls, FileCard, fileMeta, fileUrl, InlineArtifactView, OpenViewer } from "../Viewer.tsx";
import { ArtifactIcon, FileIcon, PortIcon } from "./icons.tsx";
import { artifactOf, forwardOf, sentFileOf, shownInline } from "./result-data.ts";

/** One result: an artifact or a sent file, or a port's links. `inline`: an inline artifact shows itself too. */
export function Result({ tool, inline = false }: { tool: ToolView; inline?: boolean }) {
	const sessionId = useContext(SessionId);
	const openViewer = useContext(OpenViewer);
	const InlineArtifact = useContext(InlineArtifactView);
	const artifact = artifactOf(tool);
	const file = artifact ? undefined : sentFileOf(tool);
	if (sessionId && artifact) {
		const urls = artifactUrls(sessionId, artifact);
		return (
			<>
				<FileCard
					icon={<ArtifactIcon />}
					title={artifact.title}
					meta={`${artifact.type.toUpperCase()} · version ${artifact.version}`}
					href={urls.download}
					download={urls.filename}
					onOpen={() => openViewer({ kind: "artifact", artifact })}
				/>
				{inline && shownInline(tool) && InlineArtifact && (
					<InlineArtifact sessionId={sessionId} artifact={artifact} />
				)}
			</>
		);
	}
	if (sessionId && file)
		return (
			<FileCard
				icon={<FileIcon />}
				title={file.name}
				meta={fileMeta(file)}
				href={fileUrl(sessionId, file)}
				download={file.name}
				onOpen={() => openViewer({ kind: "file", file })}
			/>
		);
	const forward = forwardOf(tool);
	if (forward)
		return (
			<div className="result-links">
				<PortIcon />
				{forward.url && (
					<a
						className="result-link"
						data-testid="tool-link"
						href={forward.url}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open {forward.name}
					</a>
				)}
				{forward.publicUrl && (
					<a
						className="result-link"
						data-testid="tool-link"
						href={forward.publicUrl}
						target="_blank"
						rel="noopener noreferrer"
					>
						Public link
					</a>
				)}
			</div>
		);
	return null;
}

export function Results({ tools }: { tools: readonly ToolView[] }) {
	return (
		<div className="results" data-testid="results">
			{tools.map((tool) => (
				<Result key={tool.id} tool={tool} inline />
			))}
		</div>
	);
}
