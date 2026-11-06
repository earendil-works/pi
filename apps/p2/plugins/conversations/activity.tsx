// How the `conversations` tool shows in the chat: whether it listed, messaged or read an answer of another
// conversation; its detail the message sent and the answer read as Markdown.
import {
	DetailNote,
	DetailProse,
	DetailSection,
	failureOf,
	OutputBlock,
	plainText,
	type Step,
	sentence,
	stringOf,
	type ToolActivity,
} from "@p2/app/v1/web";

function ConversationsDetail({ step }: { step: Step }) {
	const { tool } = step;
	const action = stringOf(tool.args.action);
	return (
		<>
			<DetailSection label="Input">
				<DetailNote>{[action, stringOf(tool.args.to)].filter(Boolean).join(" · ")}</DetailNote>
				{tool.args.message !== undefined && <DetailProse text={stringOf(tool.args.message)} />}
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
		</>
	);
}

export const conversationsActivity: ToolActivity = {
	describe(step) {
		const action = stringOf(step.tool.args.action);
		return {
			label: {
				kind: "message",
				verb:
					action === "send"
						? "Messaged a conversation"
						: action === "answer"
							? "Read an answer"
							: "Listed conversations",
			},
			description: failureOf(step) ?? (plainText(sentence(stringOf(step.tool.args.message))) || undefined),
		};
	},
	argument: (tool) => [stringOf(tool.args.action), stringOf(tool.args.message)].filter(Boolean).join(" "),
	Detail: ConversationsDetail,
};
