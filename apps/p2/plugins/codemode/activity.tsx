// How the `codemode` tool shows in the chat: "Ran a script · N calls", and its detail: the whole script
// (highlighted), its calls as a timeline (each opens its own detail) and what it printed.
import {
	CodeBlock,
	failureOf,
	firstLine,
	InputOutput,
	Interrupted,
	NestedCalls,
	OutputBlock,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
} from "@p2/app/v1/web";

/** The script's first comment: what it is for. */
const comment = (tool: ToolView) => firstLine(stringOf(tool.args.code)).replace(/^\/\/\s*/, "");
const calls = (count: number) => `${count} ${count === 1 ? "call" : "calls"}`;

function ScriptDetail({ step, onGroup }: { step: Step; onGroup: (index: number) => void }) {
	const { tool } = step;
	return (
		<InputOutput
			input={<CodeBlock code={stringOf(tool.args.code)} language="js" />}
			output={
				<>
					<NestedCalls step={step} onGroup={onGroup} />
					{tool.output.trim() && <OutputBlock output={tool.output} failed={step.status === "error"} />}
					<Interrupted step={step} />
				</>
			}
		/>
	);
}

export const codemodeActivity: ToolActivity = {
	describe(step) {
		const count = step.tool.calls?.length ?? 0;
		const failed = step.tool.calls?.filter((call) => call.status === "error").length ?? 0;
		return {
			label: {
				kind: "script",
				verb: "Ran a script",
				...(count ? { extra: `${calls(count)}${failed ? `, ${failed} failed` : ""}` } : {}),
			},
			description: failureOf(step) ?? comment(step.tool),
		};
	},
	// The calls made so far: a running script's total is not known yet.
	running: (step) => ({
		kind: "script",
		verb: "Running a script",
		...(step.tool.calls?.length ? { extra: calls(step.tool.calls.length) } : {}),
	}),
	argument: comment,
	summary: (count) => (count === 1 ? "ran a script" : `ran ${count} scripts`),
	Detail: ScriptDetail,
};
