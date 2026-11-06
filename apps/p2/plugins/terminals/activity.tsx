// How the `terminal` tool shows in the chat: its tmux command line, its output, and the terminal one tap away.
import {
	CommandBlock,
	DetailLink,
	detailsOf,
	failureOf,
	firstLine,
	InputOutput,
	lastLine,
	OpenTerminal,
	OutputBlock,
	type Step,
	stringOf,
	type ToolActivity,
	type ToolView,
} from "@p2/app/v1/web";
import { useContext } from "react";

/** A call as its tmux command line: `send-keys -t 1 C-c`. */
const commandLine = (tool: ToolView) =>
	[
		stringOf(tool.args.command),
		...(Array.isArray(tool.args.args)
			? tool.args.args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
			: []),
	]
		.filter(Boolean)
		.join(" ");

function TerminalDetail({ step }: { step: Step }) {
	const { tool } = step;
	const openTerminal = useContext(OpenTerminal);
	const details = detailsOf(tool);
	const terminalId = stringOf(details.terminalId);
	return (
		<>
			<InputOutput
				input={<CommandBlock command={commandLine(tool)} />}
				output={<OutputBlock output={tool.output} failed={step.status === "error"} />}
			/>
			{openTerminal && terminalId && tool.status === "done" && stringOf(tool.args.command) !== "kill-window" && (
				<DetailLink onClick={() => openTerminal(terminalId)}>
					Open terminal{typeof details.window === "number" ? ` ${details.window}` : ""}
				</DetailLink>
			)}
		</>
	);
}

export const terminalActivity: ToolActivity = {
	describe: (step) => ({
		label: { kind: "command", verb: "Terminal", object: commandLine(step.tool), style: "code" },
		description: failureOf(step) ?? lastLine(step.tool.output),
		mono: true,
	}),
	running: (step) => ({ kind: "command", verb: "Terminal", object: firstLine(commandLine(step.tool)), style: "code" }),
	argument: (tool) => firstLine(commandLine(tool)),
	summary: (count) => (count === 1 ? "used the terminal" : `used the terminal ${count} times`),
	Detail: TerminalDetail,
};
