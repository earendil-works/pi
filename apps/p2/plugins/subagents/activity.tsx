// How the `subagent` tool shows in the chat: what it asked which subagent, and for an answer or a spawn how it went,
// with the subagent's conversation one tap away.
import {
	DetailLink,
	DetailNote,
	DetailProse,
	DetailSection,
	detailsOf,
	failureOf,
	OpenConversation,
	OutputBlock,
	plainText,
	relativePath,
	type Step,
	sentence,
	stringOf,
	type ToolActivity,
	type ToolView,
	WorkingDirectory,
} from "@p2/app/v1/web";
import { useContext } from "react";

const VERBS: Record<string, string> = {
	spawn: "Started subagent",
	send: "Messaged",
	answer: "Read the answer of",
	status: "Checked on",
	archive: "Archived",
	restore: "Restored",
	configure: "Configured",
	stop: "Stopped",
};

const nameOf = (tool: ToolView) => stringOf(tool.args.name) || stringOf(detailsOf(tool).name);

function SubagentDetail({ step }: { step: Step }) {
	const { tool } = step;
	const openConversation = useContext(OpenConversation);
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	const details = detailsOf(tool);
	const action = stringOf(tool.args.action);
	const target = typeof details.conversationId === "number" ? details.conversationId : undefined;
	const config = [
		details.model,
		details.thinkingLevel && `thinking ${stringOf(details.thinkingLevel)}`,
		Array.isArray(details.tools) && `tools ${details.tools.join(", ") || "none"}`,
		typeof details.cwd === "string" &&
			`cwd ${typeof details.env === "string" ? `${details.env}:${details.cwd}` : relativePath(cwd, details.cwd)}`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<>
			<DetailSection label="Input">
				<DetailNote>{[action, nameOf(tool)].filter(Boolean).join(" · ")}</DetailNote>
				{tool.args.message !== undefined && <DetailProse text={stringOf(tool.args.message)} />}
				{config && <DetailNote testId="tool-config">{config}</DetailNote>}
			</DetailSection>
			{tool.output && (
				<DetailSection label="Output">
					{action === "answer" && tool.status === "done" ? (
						<DetailProse text={tool.output} />
					) : (
						<OutputBlock output={tool.output} failed={step.status === "error"} />
					)}
				</DetailSection>
			)}
			{target !== undefined && (
				<DetailLink onClick={() => openConversation(target)}>Open {nameOf(tool) || "the conversation"}</DetailLink>
			)}
		</>
	);
}

export const subagentActivity: ToolActivity = {
	describe: (step) => ({
		label: {
			kind: "agent",
			verb: VERBS[stringOf(step.tool.args.action)] ?? "Subagent",
			object: nameOf(step.tool),
			style: "file",
		},
		description: failureOf(step) ?? (plainText(sentence(stringOf(step.tool.args.message))) || undefined),
	}),
	running: (step) => ({ kind: "agent", verb: "Asking", object: stringOf(step.tool.args.name), style: "file" }),
	argument: (tool) => [stringOf(tool.args.action), nameOf(tool)].filter(Boolean).join(" "),
	summary: (count) => (count === 1 ? "used a subagent" : `used subagents ${count} times`),
	Detail: SubagentDetail,
};
