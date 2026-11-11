// How the `artifact` tool shows in the chat: "Made <title>", and the version it made as a card that opens the viewer,
// after the turn's answer; when the agent asked to show it inline, in place instead, with the artifact itself below it.
import {
	ArtifactIcon,
	artifactUrls,
	CodeBlock,
	detailsOf,
	FileCard,
	failureOf,
	InputOutput,
	OpenViewer,
	OutputBlock,
	SessionId,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
	ViewerHref,
} from "@p2/app/v1/web";
import { useContext } from "react";
import type { ArtifactInfo } from "./contract.ts";
import { InlineArtifact } from "./preview.tsx";

/** The version a call made, when its details are a complete, valid version (they come from the tool's result). */
function artifactOf(tool: ToolView): ArtifactInfo | undefined {
	const details = detailsOf(tool);
	return tool.status === "done" &&
		typeof details.name === "string" &&
		/^[a-z0-9][a-z0-9_-]{0,63}$/.test(details.name) &&
		typeof details.title === "string" &&
		["html", "svg", "markdown", "text"].includes(String(details.type)) &&
		typeof details.version === "number" &&
		Number.isSafeInteger(details.version) &&
		details.version > 0
		? // Without the details' `inline` flag: the viewer's locator is closed.
			{
				name: details.name,
				title: details.title,
				type: details.type as ArtifactInfo["type"],
				version: details.version,
			}
		: undefined;
}

/** The artifact's card; in the chat, the artifact itself below it when the agent asked to show it inline. */
function ArtifactResult({ tool, inline }: { tool: ToolView; inline: boolean }) {
	const sessionId = useContext(SessionId);
	const openViewer = useContext(OpenViewer);
	const viewerHref = useContext(ViewerHref);
	const artifact = artifactOf(tool);
	if (!sessionId || !artifact) return null;
	const urls = artifactUrls(sessionId, artifact);
	return (
		<>
			<FileCard
				icon={<ArtifactIcon />}
				title={artifact.title}
				meta={`${artifact.type.toUpperCase()} · version ${artifact.version}`}
				href={urls.download}
				download={urls.filename}
				openHref={viewerHref({ kind: "artifact", artifact })}
				onOpen={() => openViewer({ kind: "artifact", artifact })}
			/>
			{inline && detailsOf(tool).inline === true && <InlineArtifact sessionId={sessionId} artifact={artifact} />}
		</>
	);
}

function ArtifactDetail({ step }: { step: Step }) {
	const { tool } = step;
	return (
		<InputOutput
			input={<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />}
			output={
				<>
					<ArtifactResult tool={tool} inline={false} />
					{tool.output.trim() && <OutputBlock output={tool.output} failed={step.status === "error"} />}
				</>
			}
		/>
	);
}

export const artifactActivity: ToolActivity = {
	brief: "Making artifact",
	describe(step) {
		const details = detailsOf(step.tool);
		return {
			label: {
				kind: "artifact",
				verb: "Made",
				object: stringOf(details.title) || stringOf(step.tool.args.title) || stringOf(step.tool.args.name),
				style: "file",
			},
			description:
				failureOf(step) ??
				(typeof details.version === "number"
					? `${stringOf(details.type).toUpperCase() || "Artifact"} · version ${details.version}`
					: undefined),
		};
	},
	running: (step) => ({ kind: "artifact", verb: "Making", object: stringOf(step.tool.args.title), style: "file" }),
	argument: (tool) => stringOf(tool.args.title) || stringOf(tool.args.name),
	summary: (count) => (count === 1 ? "made an artifact" : `made ${count} artifacts`),
	// In place when the agent asked to show it inline (the artifact below its card, where it was made); else its card
	// after the answer.
	hasResult: (tool) => (artifactOf(tool) ? (detailsOf(tool).inline === true ? "inline" : "after") : false),
	Result: ArtifactResult,
	Detail: ArtifactDetail,
};
