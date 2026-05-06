import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Bot, Boxes, ChevronDown, CircleAlert, Code2, FileTerminal, UserRound } from "lucide-react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn, formatNumber } from "@/lib/utils";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			if (part.type === "text" && typeof part.text === "string") return part.text;
			if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
			if (part.type === "image" && typeof part.mimeType === "string") return `[image: ${part.mimeType}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function assistantText(message: JsonRecord): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

function assistantThinking(message: JsonRecord): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			isRecord(part) && part.type === "thinking" && typeof part.thinking === "string" ? part.thinking : "",
		)
		.join("");
}

function assistantToolCalls(message: JsonRecord): JsonRecord[] {
	const content = message.content;
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is JsonRecord => isRecord(part) && part.type === "toolCall");
}

function InlineMarkdown({ text }: { text: string }): React.ReactElement {
	const segments = text.split(/(`[^`]+`)/g);
	return (
		<>
			{segments.map((segment, index) => {
				const key = `${index}:${segment}`;
				if (segment.startsWith("`") && segment.endsWith("`")) {
					return <code key={key}>{segment.slice(1, -1)}</code>;
				}
				return <span key={key}>{segment}</span>;
			})}
		</>
	);
}

function MarkdownLite({ text }: { text: string }): React.ReactElement {
	const blocks = text.split(/```/g);
	return (
		<div className="prose-message space-y-3 text-sm leading-7 text-pretty">
			{blocks.map((block, blockPosition) => {
				const isCode = blockPosition % 2 === 1;
				if (isCode) {
					const lines = block.replace(/^\w+\n/, "");
					return (
						<pre key={`code:${block}`}>
							<code>{lines.trim()}</code>
						</pre>
					);
				}
				return block.split(/\n{2,}/g).map((paragraph) => {
					const trimmed = paragraph.trim();
					if (!trimmed) return null;
					if (trimmed.startsWith("#")) {
						return (
							<h3 key={`heading:${trimmed}`} className="text-base font-semibold tracking-tight">
								{trimmed.replace(/^#+\s*/, "")}
							</h3>
						);
					}
					const lines = trimmed.split("\n");
					if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
						return (
							<ul key={`list:${trimmed}`} className="ml-5 list-disc space-y-1">
								{lines.map((line) => (
									<li key={line}>
										<InlineMarkdown text={line.replace(/^\s*[-*]\s+/, "")} />
									</li>
								))}
							</ul>
						);
					}
					return (
						<p key={`p:${trimmed}`} className="whitespace-pre-wrap">
							<InlineMarkdown text={trimmed} />
						</p>
					);
				});
			})}
		</div>
	);
}

function Avatar({ kind }: { kind: "assistant" | "user" | "tool" }): React.ReactElement {
	const Icon = kind === "assistant" ? Bot : kind === "user" ? UserRound : FileTerminal;
	return (
		<div
			className={cn(
				"flex size-9 shrink-0 items-center justify-center rounded-full border shadow-sm",
				kind === "assistant" && "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
				kind === "user" && "border-stone-500/20 bg-stone-500/10 text-stone-700 dark:text-stone-200",
				kind === "tool" && "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300",
			)}
		>
			<Icon className="size-4" />
		</div>
	);
}

function ToolCallPills({ calls }: { calls: JsonRecord[] }): React.ReactElement | null {
	if (calls.length === 0) return null;
	return (
		<div className="mt-3 flex flex-wrap gap-2">
			{calls.map((call) => (
				<Badge key={String(call.id ?? call.name)} variant="blue" className="gap-1.5">
					<Boxes className="size-3" />
					{typeof call.name === "string" ? call.name : "tool"}
				</Badge>
			))}
		</div>
	);
}

function AssistantMessageView({ message }: { message: JsonRecord }): React.ReactElement {
	const text = assistantText(message);
	const thinking = assistantThinking(message);
	const toolCalls = assistantToolCalls(message);
	const error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
	return (
		<div className="flex gap-3 animate-float-up">
			<Avatar kind="assistant" />
			<Card className="max-w-[min(820px,100%)] flex-1 rounded-tl-md bg-card/78 p-4 backdrop-blur-xl">
				<div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<Badge variant="outline">pi</Badge>
					{typeof message.model === "string" ? <span>{message.model}</span> : null}
					{typeof message.stopReason === "string" ? <span>stop: {message.stopReason}</span> : null}
				</div>
				{thinking ? (
					<details className="mb-3 rounded-2xl border bg-secondary/35 p-3 text-xs text-muted-foreground">
						<summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground">
							<ChevronDown className="size-3" /> thinking
						</summary>
						<p className="mt-2 whitespace-pre-wrap leading-6">{thinking}</p>
					</details>
				) : null}
				{error ? (
					<div className="mb-3 flex gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
						<CircleAlert className="mt-0.5 size-4 shrink-0" />
						<span>{error}</span>
					</div>
				) : null}
				{text ? <MarkdownLite text={text} /> : <div className="text-sm text-muted-foreground">Working…</div>}
				<ToolCallPills calls={toolCalls} />
			</Card>
		</div>
	);
}

function UserMessageView({ message }: { message: JsonRecord }): React.ReactElement {
	const text = contentToText(message.content);
	return (
		<div className="ml-auto flex max-w-[min(720px,88%)] justify-end gap-3 animate-float-up">
			<Card className="rounded-tr-md bg-primary px-4 py-3 text-primary-foreground shadow-lg">
				<p className="whitespace-pre-wrap text-sm leading-6">{text}</p>
			</Card>
			<Avatar kind="user" />
		</div>
	);
}

function ToolResultView({ message }: { message: JsonRecord }): React.ReactElement {
	const text = contentToText(message.content ?? message.output);
	const isError = message.isError === true || (typeof message.exitCode === "number" && message.exitCode !== 0);
	const name =
		typeof message.toolName === "string"
			? message.toolName
			: typeof message.command === "string"
				? message.command
				: "tool";
	return (
		<div className="flex gap-3 animate-float-up">
			<Avatar kind="tool" />
			<Card className="max-w-[min(820px,100%)] flex-1 overflow-hidden rounded-tl-md bg-card/62 backdrop-blur-xl">
				<div className="flex items-center justify-between border-b px-4 py-3">
					<div className="flex items-center gap-2 text-sm font-medium">
						<Code2 className="size-4" />
						{name}
					</div>
					<Badge variant={isError ? "error" : "success"}>{isError ? "error" : "ok"}</Badge>
				</div>
				<pre className="max-h-80 overflow-auto p-4 text-xs leading-5 text-muted-foreground scrollbar-elegant">
					{text || "(no output)"}
				</pre>
			</Card>
		</div>
	);
}

function SummaryView({ message, type }: { message: JsonRecord; type: "compaction" | "branch" }): React.ReactElement {
	const summary = typeof message.summary === "string" ? message.summary : "";
	return (
		<div className="mx-auto max-w-3xl animate-float-up">
			<div className="rounded-2xl border bg-secondary/45 px-4 py-3 text-sm text-muted-foreground backdrop-blur-xl">
				<div className="mb-1 font-medium text-foreground">
					{type === "compaction" ? "Context compacted" : "Branch summary"}
				</div>
				<p className="line-clamp-4 whitespace-pre-wrap">{summary}</p>
				{typeof message.tokensBefore === "number" ? (
					<div className="mt-2 text-xs">{formatNumber(message.tokensBefore)} tokens before compaction</div>
				) : null}
			</div>
		</div>
	);
}

export function MessageView({ message }: { message: AgentMessage }): React.ReactElement | null {
	if (!isRecord(message) || typeof message.role !== "string") return null;
	switch (message.role) {
		case "user":
			return <UserMessageView message={message} />;
		case "assistant":
			return <AssistantMessageView message={message} />;
		case "toolResult":
		case "bashExecution":
			return <ToolResultView message={message} />;
		case "compactionSummary":
			return <SummaryView message={message} type="compaction" />;
		case "branchSummary":
			return <SummaryView message={message} type="branch" />;
		case "custom":
			if (message.display === false) return null;
			return <ToolResultView message={{ ...message, content: message.content ?? "" }} />;
		default:
			return null;
	}
}
