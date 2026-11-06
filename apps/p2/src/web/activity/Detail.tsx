// A step's detail in the sheet. A tool shows its input (the command, the file and range read, the edited file, the
// script, the message) and then its output (the command's output as a terminal, the file's numbered lines or the
// image read, the diff, the script's calls and printed output, the result card).
import { Button } from "@earendil-works/elanor-react";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type ReactNode, useContext, useState } from "react";
import { closeLayers } from "../../runtime/web.tsx";
import { CodeBlock, type CodeLine, DiffBlock, LinesBlock } from "../Code.tsx";
import {
	OneShotAgents,
	OpenConversation,
	OpenTerminal,
	OpenWorkspaceFile,
	RevealEntry,
	relativePath,
	WorkingDirectory,
} from "../chat-context.ts";
import { Timeline } from "../elanor-extra/timeline.tsx";
import { Markdown } from "../Markdown.tsx";
import { revealInTranscripts } from "../use-chat-scroll.ts";
import { KindIcon, LabelText } from "./Label.tsx";
import { type CallGroup, callStatus, groupCalls, parsedArgs, type Step } from "./model.ts";
import { Result } from "./Results.tsx";

const str = (value: unknown) => (typeof value === "string" ? value : "");
const extension = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1];
/** Lines of a command's output shown before "Show all": the end, where the result is. */
const OUTPUT_LINES = 24;
/** Lines of a script shown before "Show all". */
const SCRIPT_LINES = 12;

/** A quiet line: what a section lacks, how a call ended, a subagent's configuration. */
const Note = ({ children, testId }: { children: ReactNode; testId?: string }) => (
	<p className="detail-note" data-testid={testId}>
		{children}
	</p>
);

const Section = ({ label, children }: { label: string; children: ReactNode }) => (
	<section className="detail-section" data-testid={`detail-${label.toLowerCase()}`}>
		<h4 className="detail-label">{label}</h4>
		{children}
	</section>
);

/**
 * The entries a history tool found or read: each opens its message in the transcript (loading older history first),
 * closing the sheet so the message shows.
 */
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
								<span className="history-entry-id">#{entry}</span> {str(hit.author ?? hit.role)}
							</span>
							<span className="history-entry-text">{str(hit[field])}</span>
						</button>
					</li>,
				];
			})}
		</ul>
	);
}

/** A tool's detail: what went in, then what came out. */
export const InputOutput = ({ input, output }: { input: ReactNode; output?: ReactNode }) => (
	<>
		<Section label="Input">{input}</Section>
		{output ? <Section label="Output">{output}</Section> : null}
	</>
);

/** A command in a terminal block: the prompt and the command. */
export const Command = ({ command }: { command: string }) => (
	<div className="detail-terminal">
		<pre className="detail-command" data-testid="detail-command">
			<span className="detail-prompt" aria-hidden="true">
				${" "}
			</span>
			{command}
		</pre>
	</div>
);

/** Output in a terminal block; a long one shows its end first. A failure is red, no louder than that. */
export function Output({ output, failed }: { output: string; failed?: boolean }) {
	const lines = output.trimEnd() ? output.trimEnd().split("\n") : [];
	const [all, setAll] = useState(lines.length <= OUTPUT_LINES);
	if (!lines.length) return <Note>No output</Note>;
	return (
		<div className="detail-terminal" data-failed={failed || undefined}>
			{!all && (
				<button type="button" className="detail-more" onClick={() => setAll(true)}>
					Show all {lines.length} lines
				</button>
			)}
			<pre className="detail-output" data-testid="detail-output">
				{(all ? lines : lines.slice(-OUTPUT_LINES)).join("\n")}
			</pre>
		</div>
	);
}

/** A read's output ("40\tcode" per line) as the file's lines, numbered from where the read started. */
function readLines(output: string): CodeLine[] {
	return output.split("\n").map((line, index) => {
		const numbered = /^\s*(\d+)\t(.*)$/.exec(line);
		return numbered
			? { kind: "", number: Number(numbered[1]), text: numbered[2] ?? "" }
			: { kind: "", number: index + 1, text: line };
	});
}

/** Images a tool returned (a screenshot it read), each at the sheet's width. */
export const Images = ({ images }: { images: readonly ImageContent[] }) => (
	<div className="detail-images">
		{images.map((image, index) => (
			<img
				// biome-ignore lint/suspicious/noArrayIndexKey: a result's images never move.
				key={index}
				className="detail-image"
				src={`data:${image.mimeType};base64,${image.data}`}
				alt=""
			/>
		))}
	</div>
);

function Script({ code }: { code: string }) {
	const lines = code.split("\n");
	const [all, setAll] = useState(lines.length <= SCRIPT_LINES + 1);
	return (
		<>
			<CodeBlock code={all ? code : lines.slice(0, SCRIPT_LINES).join("\n")} language="js" />
			{!all && (
				<Button hierarchy="tertiary" onClick={() => setAll(true)}>
					Show all {lines.length} lines
				</Button>
			)}
		</>
	);
}

/** A file a tool used, with a way into the workspace (at a line) when it is inside the working directory. */
function FilePath({ path, line, range }: { path: string; line?: number; range?: string }) {
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	const openWorkspace = useContext(OpenWorkspaceFile);
	const relative = relativePath(cwd, path);
	const inside = path && !relative.startsWith("/") && relative !== "." && !relative.split("/").includes("..");
	return (
		<div className="detail-file">
			<span className="detail-path">
				{relative}
				{range}
			</span>
			{openWorkspace && inside && (
				<Button hierarchy="tertiary" data-testid="tool-link" onClick={() => openWorkspace(relative, line)}>
					Open in workspace
				</Button>
			)}
		</div>
	);
}

/** What a subagent call asked and, for answer and spawn, how it went; the conversation one tap away. */
function Subagent({ step }: { step: Step }) {
	const { tool } = step;
	const openConversation = useContext(OpenConversation);
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	const details = tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details : {};
	const action = str(tool.args.action);
	const target = typeof details.conversationId === "number" ? details.conversationId : undefined;
	const config = [
		details.model,
		details.thinkingLevel && `thinking ${str(details.thinkingLevel)}`,
		Array.isArray(details.tools) && `tools ${details.tools.join(", ") || "none"}`,
		typeof details.cwd === "string" &&
			`cwd ${typeof details.env === "string" ? `${details.env}:${details.cwd}` : relativePath(cwd, details.cwd)}`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<>
			<Section label="Input">
				<Note>{[action, str(tool.args.name) || str(details.name)].filter(Boolean).join(" · ")}</Note>
				{tool.args.message !== undefined && (
					<div className="detail-prose" data-text-context="prose">
						<Markdown text={str(tool.args.message)} />
					</div>
				)}
				{config && <Note testId="tool-config">{config}</Note>}
			</Section>
			{tool.output &&
				(action === "answer" && tool.status === "done" ? (
					<Section label="Output">
						<div className="detail-prose" data-text-context="prose">
							<Markdown text={tool.output} />
						</div>
					</Section>
				) : (
					<Section label="Output">
						<Output output={tool.output} failed={step.status === "error"} />
					</Section>
				))}
			{target !== undefined && (
				<Button hierarchy="secondary" data-testid="tool-link" onClick={() => openConversation(target)}>
					Open {str(details.name) || "the conversation"}
				</Button>
			)}
		</>
	);
}

/** A terminal call: its tmux command line and output, and the terminal one tap away once it ran. */
function Terminal({ step }: { step: Step }) {
	const { tool } = step;
	const openTerminal = useContext(OpenTerminal);
	const details = tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details : {};
	const argv = Array.isArray(tool.args.args)
		? tool.args.args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
		: [];
	const terminalId = typeof details.terminalId === "string" ? details.terminalId : undefined;
	return (
		<>
			<InputOutput
				input={<Command command={[str(tool.args.command), ...argv].join(" ")} />}
				output={<Output output={tool.output} failed={step.status === "error"} />}
			/>
			{openTerminal && terminalId && tool.status === "done" && str(tool.args.command) !== "kill-window" && (
				<Button hierarchy="secondary" data-testid="tool-link" onClick={() => openTerminal(terminalId)}>
					Open terminal{typeof details.window === "number" ? ` ${details.window}` : ""}
				</Button>
			)}
		</>
	);
}

export function StepDetail({ step, onGroup }: { step: Step; onGroup: (index: number) => void }) {
	const { tool } = step;
	const failed = step.status === "error";
	const details = tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details : {};
	const path = str(tool.args.path);
	const interrupted = tool.status === "interrupted" && <Note>Interrupted by a restart, not run again.</Note>;
	switch (tool.name) {
		case "bash":
			return (
				<>
					<InputOutput
						input={<Command command={str(tool.args.command)} />}
						output={<Output output={tool.output} failed={failed} />}
					/>
					{interrupted}
				</>
			);
		case "read": {
			const offset = typeof tool.args.offset === "number" ? tool.args.offset : undefined;
			const limit = typeof tool.args.limit === "number" ? tool.args.limit : undefined;
			return (
				<InputOutput
					input={
						<FilePath
							path={path}
							line={offset}
							range={offset ? ` · lines ${offset}–${offset + (limit ?? 1) - 1}` : undefined}
						/>
					}
					output={
						tool.images.length ? (
							<Images images={tool.images} />
						) : failed ? (
							<Output output={tool.output} failed />
						) : (
							<LinesBlock lines={readLines(tool.output.trimEnd())} language={extension(path)} />
						)
					}
				/>
			);
		}
		case "edit":
		case "write": {
			const diff = typeof details.diff === "string" ? details.diff : undefined;
			const first = diff ? /^[+-]\s*(\d+) /m.exec(diff)?.[1] : undefined;
			return (
				<InputOutput
					input={<FilePath path={path} line={first ? Number(first) : undefined} />}
					output={
						failed ? (
							<Output output={tool.output} failed />
						) : diff ? (
							<DiffBlock diff={diff} language={path} />
						) : (
							<CodeBlock code={str(tool.args.content) || tool.output} language={extension(path)} />
						)
					}
				/>
			);
		}
		case "terminal":
			return <Terminal step={step} />;
		case "codemode":
			return (
				<InputOutput
					input={<Script code={str(tool.args.code)} />}
					output={
						<>
							{tool.calls?.length ? (
								<Timeline.Root data-testid="calls">
									{groupCalls(tool.calls).map((group, index) => (
										<Timeline.Item
											key={group.key}
											data-testid="call"
											data-state={group.status}
											status={group.status}
											icon={<KindIcon kind={group.label.kind} />}
											title={<LabelText label={group.label} />}
											description={group.description}
											code={group.calls.length === 1 && (group.mono || group.status === "error")}
											onClick={() => onGroup(index)}
										/>
									))}
								</Timeline.Root>
							) : null}
							{tool.output.trim() && <Output output={tool.output} failed={failed} />}
							{interrupted}
						</>
					}
				/>
			);
		case "history_search":
		case "history_read": {
			const rows = tool.name === "history_search" ? details.hits : details.entries;
			const listed = Array.isArray(rows) && rows.length > 0;
			return (
				<InputOutput
					input={
						tool.name === "history_search" ? (
							<Command command={str(tool.args.query)} />
						) : (
							<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />
						)
					}
					output={
						listed ? (
							<>
								<HistoryEntries rows={rows} field={tool.name === "history_search" ? "snippet" : "preview"} />
								{details.more === true && <Note>More matches</Note>}
								{details.truncated === true && <Note>Cut at the output budget</Note>}
							</>
						) : (
							<Output output={tool.output} failed={failed} />
						)
					}
				/>
			);
		}
		case "history_handoff":
			return (
				<>
					<div className="detail-prose" data-text-context="prose">
						<Markdown text={str(tool.args.text)} />
					</div>
					<Note>New context started; earlier history stays searchable.</Note>
				</>
			);
		case "subagent":
			return <Subagent step={step} />;
		case "artifact":
		case "send_file":
		case "ports":
			return (
				<InputOutput
					input={<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />}
					output={
						<>
							<Result tool={tool} />
							{tool.output.trim() && <Output output={tool.output} failed={failed} />}
						</>
					}
				/>
			);
		default:
			return (
				<>
					<InputOutput
						input={<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />}
						output={
							<>
								{tool.images.length > 0 && <Images images={tool.images} />}
								{(tool.output.trim() || !tool.images.length) && <Output output={tool.output} failed={failed} />}
							</>
						}
					/>
					{interrupted}
				</>
			);
	}
}

/** One entry of a script's calls: its input, then its result, or the runs of a repeated call. */
export function GroupDetail({ group }: { group: CallGroup }) {
	const agents = useContext(OneShotAgents);
	const openConversation = useContext(OpenConversation);
	const first = group.calls[0];
	if (!first) return null;
	const args = parsedArgs(first.args);
	const command = typeof args.command === "string" ? args.command : undefined;
	const input = command ? (
		<Command command={command} />
	) : (
		<CodeBlock code={typeof first.args === "string" ? first.args : JSON.stringify(args, null, 2)} language="json" />
	);
	const agent = first.name === "agent" ? agents.get(first.id) : undefined;
	if (group.calls.length > 1)
		return (
			<InputOutput
				input={input}
				output={
					<Timeline.Root>
						{group.calls.map((call, index) => (
							<Timeline.Item
								key={call.id}
								status={callStatus(call.status)}
								title={`Run ${index + 1}`}
								description={call.error}
								code={Boolean(call.error)}
							/>
						))}
					</Timeline.Root>
				}
			/>
		);
	return (
		<>
			<InputOutput
				input={input}
				output={<Output output={first.error ?? first.output ?? ""} failed={group.status === "error"} />}
			/>
			{agent !== undefined && (
				<Button hierarchy="secondary" data-testid="nested-open" onClick={() => openConversation(agent)}>
					Open the agent's conversation
				</Button>
			)}
		</>
	);
}
