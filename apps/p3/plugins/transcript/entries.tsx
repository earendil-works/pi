// A transcript's entries as people read them: their messages, the agent's answers with their tool calls (each with
// its output: the result once there, the running output from `pi.live` while it runs), markers where the context
// was summarized or started over, and the answer being streamed (`pi.live`'s partial message).

import type {
	AssistantMessage,
	EntryRecord,
	LiveState,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/p3/v1/web";
import styles from "./entries.module.css";

/** The entries, oldest first, then what `live` shows of the running run. */
export function Entries(props: { readonly entries: readonly EntryRecord[]; readonly live: LiveState }) {
	const results = resultsOf(props.entries);
	const calls = new Set(props.entries.flatMap((entry) => callsOf(entry).map((call) => call.id)));
	const running = new Map((props.live.tools ?? []).map((slot) => [slot.callId, slot.output ?? ""] as const));
	const partial = props.live.generation?.message;
	return (
		<ol className={styles.entries} data-entries="">
			{props.entries.map((entry) => (
				<EntryItem calls={calls} entry={entry} key={entry.id} results={results} running={running} />
			))}
			{partial === undefined ? null : (
				<li className={styles.assistant} data-entry="partial">
					{/* `pi.live` holds the partial message in its JSON form, which is the message's. */}
					<Answer message={partial as AssistantMessage} results={results} running={running} />
				</li>
			)}
			{props.live.runFailure === undefined ? null : (
				<li className={styles.failure} data-entry="failure">
					The run ended without an answer ({props.live.runFailure.reason}
					{props.live.runFailure.detail === undefined ? "" : `: ${props.live.runFailure.detail}`}).
				</li>
			)}
		</ol>
	);
}

/** One entry: a message, an answer, a tool result whose call is not shown, or a marker; others show nothing. */
function EntryItem(props: {
	readonly entry: EntryRecord;
	readonly calls: ReadonlySet<string>;
	readonly results: ReadonlyMap<string, ToolResultMessage>;
	readonly running: ReadonlyMap<string, string>;
}) {
	const message = props.entry.model?.[0];
	switch (props.entry.kind) {
		case "pi.user":
			return message?.role === "user" ? (
				<li className={styles.user} data-entry="user">
					<p className={styles.text}>{userText(message)}</p>
				</li>
			) : null;
		case "pi.assistant":
			return message?.role === "assistant" ? (
				<li className={styles.assistant} data-entry="assistant">
					<Answer message={message} results={props.results} running={props.running} />
				</li>
			) : null;
		case "pi.tool-result":
			// Shown with its call; alone only while its call lies before what is loaded.
			return message?.role === "toolResult" && !props.calls.has(message.toolCallId) ? (
				<li className={styles.assistant} data-entry="tool-result">
					<ToolCallView name={message.toolName} result={message} running={undefined} />
				</li>
			) : null;
		case "pi.compaction":
			return <Marker text="Earlier messages were summarized." />;
		case "pi.reset":
			return <Marker text="A new context starts here." />;
		default:
			return null;
	}
}

/** A marker between entries. */
function Marker(props: { readonly text: string }) {
	return (
		<li className={styles.marker} data-entry="marker">
			{props.text}
		</li>
	);
}

/** An answer: its text, its thinking (folded), its tool calls with their output, and its error. */
function Answer(props: {
	readonly message: AssistantMessage;
	readonly results: ReadonlyMap<string, ToolResultMessage>;
	readonly running: ReadonlyMap<string, string>;
}) {
	const { message } = props;
	return (
		<>
			{message.content.map((part, index) => (
				// Parts never move within a message: the index is their identity.
				<Part key={`${part.type}:${index}`} part={part} results={props.results} running={props.running} />
			))}
			{message.stopReason === "error" || message.stopReason === "aborted" ? (
				<p className={styles.error}>
					{message.errorMessage ?? (message.stopReason === "aborted" ? "Stopped." : "Failed.")}
				</p>
			) : null}
		</>
	);
}

/** One part of an answer: text, thinking (folded), or a tool call with its output. */
function Part(props: {
	readonly part: AssistantMessage["content"][number];
	readonly results: ReadonlyMap<string, ToolResultMessage>;
	readonly running: ReadonlyMap<string, string>;
}) {
	const { part } = props;
	switch (part.type) {
		case "text":
			return part.text === "" ? null : <p className={styles.text}>{part.text}</p>;
		case "thinking":
			return part.thinking === "" ? null : (
				<details className={styles.thinking}>
					<summary>Thinking</summary>
					<p className={styles.text}>{part.thinking}</p>
				</details>
			);
		case "toolCall":
			return (
				<ToolCallView
					call={part}
					name={part.name}
					result={props.results.get(part.id)}
					running={props.running.get(part.id)}
				/>
			);
	}
}

/** A tool call: its name and arguments, folded with its output (the result, or what it printed so far). */
function ToolCallView(props: {
	readonly name: string;
	readonly call?: ToolCall;
	readonly result: ToolResultMessage | undefined;
	readonly running: string | undefined;
}) {
	const args = props.call === undefined ? "" : JSON.stringify(props.call.arguments);
	const shown = props.call === undefined || Object.keys(props.call.arguments).length === 0 ? undefined : props.call;
	const output = props.result === undefined ? props.running : resultText(props.result);
	const state = props.result === undefined ? "running" : props.result.isError ? "error" : "done";
	return (
		<details className={styles.tool} data-state={state} data-tool={props.name}>
			<summary className={styles.toolSummary}>
				<span className={styles.toolName}>{props.name}</span>
				<span className={styles.toolArgs}>{args}</span>
			</summary>
			{shown === undefined ? null : <pre className={styles.code}>{JSON.stringify(shown.arguments, null, 2)}</pre>}
			{output === undefined || output === "" ? null : <pre className={styles.code}>{output}</pre>}
		</details>
	);
}

/** The tool results among `entries`, by the id of the call they answer. */
function resultsOf(entries: readonly EntryRecord[]): ReadonlyMap<string, ToolResultMessage> {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (entry.kind === "pi.tool-result" && message?.role === "toolResult") results.set(message.toolCallId, message);
	}
	return results;
}

/** The tool calls of an answer entry (none for other entries). */
function callsOf(entry: EntryRecord): readonly ToolCall[] {
	const message = entry.model?.[0];
	if (entry.kind !== "pi.assistant" || message?.role !== "assistant") return [];
	return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

/** A user message's text (its images aside). */
function userText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** A tool result's text (its images aside). */
function resultText(result: ToolResultMessage): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
