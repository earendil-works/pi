// A call's detail in the sheet: its tool's own (`ToolActivity.Detail`, contributed by the plugin that owns the tool),
// or the generic one: the input as JSON, then the output. The parts tools build theirs from are here too: sections,
// a command and its output as a terminal, a file with a way into the workspace, images, prose, a call's own calls.
import { Button } from "@earendil-works/elanor-react";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type ReactNode, useContext, useState } from "react";
import { CodeBlock } from "../Code.tsx";
import { OpenWorkspaceFile, relativePath, ToolActivityContext, WorkingDirectory } from "../chat-context.ts";
import { Timeline } from "../elanor-extra/timeline.tsx";
import { Markdown } from "../Markdown.tsx";
import { KindIcon, LabelText } from "./Label.tsx";
import { type CallGroup, callStatus, groupCalls, parsedArgs, type Step } from "./model.ts";

/** A quiet line: what a section lacks, how a call ended, a subagent's configuration. */
export const DetailNote = ({ children, testId }: { children: ReactNode; testId?: string }) => (
	<p className="detail-note" data-testid={testId}>
		{children}
	</p>
);

/** A labelled part of a detail ("Input", "Output"). */
export const DetailSection = ({ label, children }: { label: string; children: ReactNode }) => (
	<section className="detail-section" data-testid={`detail-${label.toLowerCase()}`}>
		<h4 className="detail-label">{label}</h4>
		{children}
	</section>
);

/** A call's detail: what went in, then what came out. */
export const InputOutput = ({ input, output }: { input: ReactNode; output?: ReactNode }) => (
	<>
		<DetailSection label="Input">{input}</DetailSection>
		{output ? <DetailSection label="Output">{output}</DetailSection> : null}
	</>
);

/** A command in a terminal block: the prompt and the command. */
export const CommandBlock = ({ command }: { command: string }) => (
	<div className="detail-terminal">
		<pre className="detail-command" data-testid="detail-command">
			<span className="detail-prompt" aria-hidden="true">
				${" "}
			</span>
			{command}
		</pre>
	</div>
);

/**
 * Output in a terminal block, whole: a long one scrolls with the sheet (a detail has no collapsed parts). A failure is
 * red, no louder than that.
 */
export function OutputBlock({ output, failed }: { output: string; failed?: boolean }) {
	const text = output.trimEnd();
	if (!text) return <DetailNote>No output</DetailNote>;
	return (
		<div className="detail-terminal" data-failed={failed || undefined}>
			<pre className="detail-output">{text}</pre>
		</div>
	);
}

/** Images a tool returned (a screenshot it read), each at the sheet's width. */
export const DetailImages = ({ images }: { images: readonly ImageContent[] }) => (
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

/** Markdown in a detail: a message, an answer. */
export const DetailProse = ({ text }: { text: string }) => (
	<div className="detail-prose" data-text-context="prose">
		<Markdown text={text} />
	</div>
);

/** A button below a detail that leads somewhere (a conversation, a terminal). */
export const DetailLink = ({
	children,
	onClick,
	testId = "tool-link",
}: {
	children: ReactNode;
	onClick: () => void;
	testId?: string;
}) => (
	<Button hierarchy="secondary" data-testid={testId} onClick={onClick}>
		{children}
	</Button>
);

/** A file a tool used, with a way into the workspace (at a line) when it is inside the working directory. */
export function FilePath({ path, line, range }: { path: string; line?: number; range?: string }) {
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

/** Entries of a call's own calls shown before "Show all": the newest, as before the activity view. */
const NEWEST_CALLS = 8;

/**
 * A call's own calls (a script's), as a timeline: repeated identical calls are one entry; each opens its detail. The
 * newest eight show, the rest behind "Show all".
 */
export function NestedCalls({ step, onGroup }: { step: Step; onGroup: (index: number) => void }) {
	const tools = useContext(ToolActivityContext);
	const [all, setAll] = useState(false);
	const calls = step.tool.calls ?? [];
	if (!calls.length) return null;
	const groups = groupCalls(calls, tools, step.tool.name);
	const from = all ? 0 : Math.max(0, groups.length - NEWEST_CALLS);
	const failed = calls.filter((call) => call.status === "error" || call.status === "interrupted").length;
	const count = `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}${failed ? ` · ${failed} failed` : ""}`;
	return (
		<>
			{groups.length > NEWEST_CALLS && (
				<button
					type="button"
					className="detail-more"
					data-testid="calls-more"
					aria-expanded={all}
					onClick={() => setAll(!all)}
				>
					{all ? "Show newest calls" : `Show all ${count}`}
				</button>
			)}
			<Timeline.Root data-testid="calls">
				{groups.slice(from).map((group, index) => (
					<Timeline.Item
						key={group.key}
						data-testid="call"
						data-state={group.status}
						status={group.status}
						icon={<KindIcon kind={group.label.kind} />}
						title={<LabelText label={group.label} />}
						description={group.description}
						code={group.calls.length === 1 && (group.mono || group.status === "error")}
						onClick={() => onGroup(from + index)}
					/>
				))}
			</Timeline.Root>
		</>
	);
}

/** The generic detail: the input as JSON, then the output and images. */
function GenericDetail({ step }: { step: Step }) {
	const { tool } = step;
	return (
		<>
			<InputOutput
				input={<CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />}
				output={
					<>
						{tool.images.length > 0 && <DetailImages images={tool.images} />}
						{(tool.output.trim() || !tool.images.length) && (
							<OutputBlock output={tool.output} failed={step.status === "error"} />
						)}
					</>
				}
			/>
			<Interrupted step={step} />
		</>
	);
}

/** Says when a restart cut a call short: it was not run again. */
export const Interrupted = ({ step }: { step: Step }) =>
	step.tool.status === "interrupted" ? <DetailNote>Interrupted by a restart, not run again.</DetailNote> : null;

/** A call's detail: its tool's, or the generic one. */
export function StepDetail({ step, onGroup }: { step: Step; onGroup: (index: number) => void }) {
	const Detail = useContext(ToolActivityContext).get(step.tool.name)?.Detail;
	return Detail ? <Detail step={step} onGroup={onGroup} /> : <GenericDetail step={step} />;
}

/**
 * One entry of a call's own calls: its input (as its tool shows another call's call of it, else JSON), then its result,
 * or the runs of a repeated call.
 */
export function GroupDetail({ group }: { group: CallGroup }) {
	const tools = useContext(ToolActivityContext);
	const first = group.calls[0];
	if (!first) return null;
	const CallInput = tools.get(first.name)?.CallInput;
	const input = CallInput ? (
		<CallInput call={first} />
	) : (
		<CodeBlock
			code={typeof first.args === "string" ? first.args : JSON.stringify(parsedArgs(first.args), null, 2)}
			language="json"
		/>
	);
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
	const CallDetail = tools.get(first.name)?.CallDetail;
	return (
		<>
			<InputOutput
				input={input}
				output={<OutputBlock output={first.error ?? first.output ?? ""} failed={group.status === "error"} />}
			/>
			{CallDetail && <CallDetail call={first} />}
		</>
	);
}
