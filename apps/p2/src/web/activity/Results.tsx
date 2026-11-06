// What a turn made for the person, after its answer: each call's result as its tool's plugin shows it
// (`ToolActivity.Result`: an artifact or a sent file as a card, an opened port's links). The same calls are in their
// run's sheet too.
import { useContext } from "react";
import { ToolActivityContext } from "../chat-context.ts";
import type { ToolView } from "../transcript.ts";

/** One call's result, by its tool's contribution; `inline`: in the chat, where an inline artifact shows itself too. */
export function Result({ tool, inline = false }: { tool: ToolView; inline?: boolean }) {
	const View = useContext(ToolActivityContext).get(tool.name)?.Result;
	return View ? <View tool={tool} inline={inline} /> : null;
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
