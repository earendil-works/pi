// How `word_count` calls show in the chat: on the wheel, in a run's summary, in the step list and in the detail.
import {
	DetailNote,
	DetailProse,
	detailsOf,
	failureOf,
	firstLine,
	InputOutput,
	Interrupted,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
} from "@p2/app/v1/web";

/** The counts a finished call's result keeps (`details`), if it has them. */
function counts(tool: ToolView): string | undefined {
	const { words, lines } = detailsOf(tool);
	return typeof words === "number" && typeof lines === "number" ? `${words} words, ${lines} lines` : undefined;
}

/** The text's first line, short: what a call is about. */
const excerpt = (tool: ToolView) => firstLine(stringOf(tool.args.text)).slice(0, 40);

function WordCountDetail({ step }: { step: Step }) {
	return (
		<>
			<InputOutput
				input={<DetailProse text={stringOf(step.tool.args.text)} />}
				output={<DetailNote testId="word-count">{failureOf(step) ?? counts(step.tool) ?? "Counting…"}</DetailNote>}
			/>
			<Interrupted step={step} />
		</>
	);
}

export const wordCountActivity: ToolActivity = {
	describe: (step) => ({
		label: { kind: "read", verb: "Counted words in", object: excerpt(step.tool), style: "words" },
		description: failureOf(step) ?? counts(step.tool),
	}),
	running: (step) => ({ kind: "read", verb: "Counting words in", object: excerpt(step.tool), style: "words" }),
	argument: excerpt,
	failure: (tool) => (tool.output.startsWith("Nothing to count") ? "empty text" : undefined),
	summary: (count) => (count === 1 ? "counted words in a text" : `counted words in ${count} texts`),
	Detail: WordCountDetail,
};
