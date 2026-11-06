// How the history tools show in the chat: what was searched or read, and the entries found, each opening its message
// in the transcript (loading older history first); a handoff's text.
import {
	CodeBlock,
	CommandBlock,
	closeLayers,
	type Described,
	DetailNote,
	DetailProse,
	detailsOf,
	failureOf,
	InputOutput,
	OutputBlock,
	plainText,
	RevealEntry,
	revealInTranscripts,
	type Step,
	sentence,
	stringOf,
	type ToolActivity,
} from "@p2/app/v1/web";
import { useContext } from "react";
import "./activity.css";

/** The entries a history tool found or read: each opens its message in the transcript, closing the sheet. */
function HistoryEntries({ rows, field }: { rows: unknown; field: "snippet" | "preview" }) {
	const reveal = useContext(RevealEntry);
	if (!Array.isArray(rows) || !rows.length) return null;
	const show = async (entry: number) => {
		closeLayers();
		if (revealInTranscripts(entry) || !reveal || !(await reveal(entry))) return;
		for (let frame = 0; frame < 60; frame++) {
			await new Promise((resolve) => requestAnimationFrame(resolve));
			if (revealInTranscripts(entry)) return;
		}
	};
	return (
		<ul className="history-entries" data-testid="history-entries">
			{rows.flatMap((row) => {
				const hit = row as {
					entry?: unknown;
					role?: unknown;
					author?: unknown;
					snippet?: unknown;
					preview?: unknown;
				};
				if (typeof hit.entry !== "number") return [];
				const entry = hit.entry;
				return [
					<li key={entry}>
						<button type="button" className="history-entry" onClick={() => void show(entry)}>
							<span className="history-entry-head">
								<span className="history-entry-id">#{entry}</span> {stringOf(hit.author ?? hit.role)}
							</span>
							<span className="history-entry-text">{stringOf(hit[field])}</span>
						</button>
					</li>,
				];
			})}
		</ul>
	);
}

function HistoryDetail({ step }: { step: Step }) {
	const { tool } = step;
	const details = detailsOf(tool);
	const search = tool.name === "history_search";
	const rows = search ? details.hits : details.entries;
	return (
		<InputOutput
			input={
				search ? (
					<CommandBlock command={stringOf(tool.args.query)} />
				) : (
					<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />
				)
			}
			output={
				Array.isArray(rows) && rows.length > 0 ? (
					<>
						<HistoryEntries rows={rows} field={search ? "snippet" : "preview"} />
						{details.more === true && <DetailNote>More matches</DetailNote>}
						{details.truncated === true && <DetailNote>Cut at the output budget</DetailNote>}
					</>
				) : (
					<OutputBlock output={tool.output} failed={step.status === "error"} />
				)
			}
		/>
	);
}

/** history_search and history_read count together in a run's summary: the same function. */
const looked = () => "looked through the history";

const historySearch: ToolActivity = {
	describe(step) {
		const details = detailsOf(step.tool);
		const hits = Array.isArray(details.hits) ? details.hits.length : 0;
		return {
			label: {
				kind: "search",
				verb: "Searched the history for",
				object: stringOf(step.tool.args.query),
				style: "words",
			},
			description:
				failureOf(step) ??
				(step.status === "done"
					? `${hits ? `${hits} ${hits === 1 ? "match" : "matches"}` : "No matches"}${details.more === true ? ", and more" : ""}`
					: undefined),
		};
	},
	running: (step) => ({
		kind: "search",
		verb: "Searching the history for",
		object: stringOf(step.tool.args.query),
		style: "words",
	}),
	argument: (tool) => stringOf(tool.args.query),
	summary: looked,
	Detail: HistoryDetail,
};

function describeRead(step: Step): Described {
	const { args } = step.tool;
	const details = detailsOf(step.tool);
	const mode = stringOf(args.mode);
	const entries = Array.isArray(details.entries) ? details.entries.length : 0;
	const count = `${entries} ${entries === 1 ? "entry" : "entries"}`;
	const range =
		mode === "range" ? `#${String(args.from)}${args.to === undefined ? "" : `–#${String(args.to)}`}` : undefined;
	return {
		label: { kind: "read", verb: "Read the history", ...(range ? { object: range, style: "code" as const } : {}) },
		description:
			failureOf(step) ??
			(step.status === "done"
				? mode === "tail"
					? `${count} before the last compaction or handoff`
					: `${count}${details.truncated === true ? ", cut at the output budget" : ""}`
				: undefined),
	};
}

const historyRead: ToolActivity = {
	describe: describeRead,
	running: (step) => ({ ...describeRead(step).label, verb: "Reading the history" }),
	argument: (tool) => stringOf(tool.args.mode),
	summary: looked,
	Detail: HistoryDetail,
};

function HandoffDetail({ step }: { step: Step }) {
	return (
		<>
			<DetailProse text={stringOf(step.tool.args.text)} />
			<DetailNote>New context started; earlier history stays searchable.</DetailNote>
		</>
	);
}

const historyHandoff: ToolActivity = {
	describe: (step) => ({
		label: { kind: "handoff", verb: "Handed off to a new context" },
		description: failureOf(step) ?? (plainText(sentence(stringOf(step.tool.args.text))) || undefined),
	}),
	running: () => ({ kind: "handoff", verb: "Handing off to a new context" }),
	argument: (tool) => plainText(sentence(stringOf(tool.args.text))),
	summary: () => "handed off",
	Detail: HandoffDetail,
};

/** The history tools' contributions, by tool name. */
export const historyActivities: Record<string, ToolActivity> = {
	history_search: historySearch,
	history_read: historyRead,
	history_handoff: historyHandoff,
};
