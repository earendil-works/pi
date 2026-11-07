// How the `send_file` tool shows in the chat: "Sent <name>", and the file as a card after the turn's answer that opens
// the viewer.
import {
	CodeBlock,
	detailsOf,
	FileCard,
	FileIcon,
	failureOf,
	fileMeta,
	fileName,
	fileUrl,
	InputOutput,
	OpenViewer,
	OutputBlock,
	relativePath,
	SessionId,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
} from "@p2/app/v1/web";
import { useContext } from "react";
import type { DownloadInfo } from "../files/contract.ts";

/** The file a call sent, when its details are complete and valid (they come from the tool's result). */
function sentFileOf(tool: ToolView): DownloadInfo | undefined {
	const details = detailsOf(tool);
	return tool.status === "done" &&
		typeof details.id === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(details.id) &&
		typeof details.name === "string" &&
		typeof details.size === "number" &&
		details.size >= 0
		? { id: details.id, name: details.name, size: details.size }
		: undefined;
}

function SentFile({ tool }: { tool: ToolView }) {
	const sessionId = useContext(SessionId);
	const openViewer = useContext(OpenViewer);
	const file = sentFileOf(tool);
	if (!sessionId || !file) return null;
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
}

function SendFileDetail({ step }: { step: Step }) {
	const { tool } = step;
	return (
		<InputOutput
			input={<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />}
			output={
				<>
					<SentFile tool={tool} />
					{tool.output.trim() && <OutputBlock output={tool.output} failed={step.status === "error"} />}
				</>
			}
		/>
	);
}

export const sendFileActivity: ToolActivity = {
	describe: (step) => ({
		label: {
			kind: "file",
			verb: "Sent",
			object: stringOf(detailsOf(step.tool).name) || fileName(stringOf(step.tool.args.path)),
			style: "file",
		},
		description: failureOf(step) ?? stringOf(step.tool.args.path),
	}),
	running: (step) => ({
		kind: "file",
		verb: "Sending",
		object: fileName(stringOf(step.tool.args.path)),
		style: "file",
	}),
	argument: (tool, cwd) => relativePath(cwd, stringOf(tool.args.path)),
	summary: (count) => (count === 1 ? "sent a file" : `sent ${count} files`),
	hasResult: (tool) => (sentFileOf(tool) ? "after" : false),
	Result: SentFile,
	Detail: SendFileDetail,
};
