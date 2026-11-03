import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
	type CSSProperties,
	createContext,
	memo,
	type PointerEvent,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { ArtifactInfo } from "../runtime/schemas.ts";
import { CodeBlock, CopyButton, DiffBlock } from "./Code.tsx";
import {
	AlertIcon,
	ArtifactIcon,
	BotIcon,
	CheckIcon,
	ChevronIcon,
	CodeIcon,
	FileIcon,
	PencilIcon,
	RefreshIcon,
	ReplyIcon,
	SearchIcon,
	SparkIcon,
	TerminalIcon,
	ToolIcon,
} from "./icons.tsx";
import { imageSize } from "./image-size.ts";
import { Markdown } from "./Markdown.tsx";
import { RowEstimator, type RowFeatures } from "./row-estimate.ts";
import type { Item, NestedCall, ToolView, Transcript } from "./transcript.ts";
import { type RowRange, revealInTranscripts, type TranscriptScroll } from "./use-chat-scroll.ts";
import { artifactUrls, FileCard, fileMeta, fileUrl, OpenViewer } from "./Viewer.tsx";

function tokens(count: number): string {
	return count < 1000
		? String(count)
		: count < 1_000_000
			? `${(count / 1000).toFixed(1)}k`
			: `${(count / 1e6).toFixed(2)}M`;
}

/** The context bar; without `used` and `limit` (not known yet) a loading skeleton of it, in the same space. */
export function ContextUsage({ used, limit }: { used?: number; limit?: number }) {
	if (used === undefined || limit === undefined)
		return (
			<output className="context-usage pending" aria-label="Loading the context usage" aria-busy="true">
				<span className="context-track" />
				{/* The numbers' text, invisible under its skeleton: the same box as the numbers that replace it. */}
				<span className="usage skeleton-text" aria-hidden="true">
					00%/000k
				</span>
			</output>
		);
	const percent = Math.round((used / limit) * 100);
	const filled = Math.min(100, Math.max(0, percent));
	return (
		<div className="context-usage">
			<progress
				className="context-track"
				aria-label="Estimated active context usage"
				value={filled}
				max={100}
				aria-valuetext={`${percent}% of ${limit.toLocaleString()} tokens`}
			>
				{percent}%
			</progress>
			<span
				className="usage"
				title={`Estimated active context: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens`}
			>
				{percent}%/{tokens(limit).replace(".0k", "k")}
			</span>
		</div>
	);
}

/** Opens a subagent conversation of the current session. */
export const OpenConversation = createContext<(conversationId: number) => void>(() => {});
/** The session's one-shot agents: conversation by the nested call ID that ran them (`<script call ID>/c<n>`). */
export const OneShotAgents = createContext<ReadonlyMap<string, number>>(new Map());
/** Owner-only navigation to another session's root; absent for guest views. */
export const OpenPeerConversation = createContext<((sessionId: string) => void) | undefined>(undefined);
/** Tool paths are displayed relative to the containing session's working directory. */
export const WorkingDirectory = createContext<string | undefined>(undefined);
/** Opens a cwd-relative file in the workspace panel; absent when the viewer has no workspace access. */
export const OpenWorkspaceFile = createContext<((path: string, line?: number) => void) | undefined>(undefined);
/** Download and artifact locators are scoped to the containing session, including child views. */
export const SessionId = createContext<string | undefined>(undefined);
/** Starts a reply to an entry; absent while the conversation accepts no replies (chat-mode turns them on). */
export const ReplyTo = createContext<((target: { entryId: number; name: string }) => void) | undefined>(undefined);

/** Loads older history until an entry is retained; false when the conversation has no such entry. */
export const RevealEntry = createContext<((entryId: number) => Promise<boolean>) | undefined>(undefined);

/** Loads the next page of a gap's missing entries; absent while nothing can load them. */
export const FillGap = createContext<((gap: Extract<Item, { type: "gap" }>["gap"]) => void) | undefined>(undefined);

/**
 * A gap's row, styled as the transcript's top edge: its entries load once it is rendered (the virtual list renders
 * rows near the viewport) and on a tap after a failed load.
 */
function GapRow({ item }: { item: Extract<Item, { type: "gap" }> }) {
	const fill = useContext(FillGap);
	const { gap, loading } = item;
	useEffect(() => fill?.(gap), [fill, gap]);
	return (
		<button
			type="button"
			className={`history-edge earlier${loading ? " loading" : ""}`}
			disabled={loading}
			aria-busy={loading}
			onClick={() => fill?.(gap)}
		>
			<span className="spinner" aria-hidden="true" />
			Load more
		</button>
	);
}

/** Shows an entry, loading older history first when it is not loaded yet (`reveal`), then waiting for its render. */
export async function revealEntry(
	entryId: number,
	reveal: ((entryId: number) => Promise<boolean>) | undefined,
): Promise<boolean> {
	if (jumpToEntry(entryId)) return true;
	if (!reveal || !(await reveal(entryId))) return false;
	for (let frame = 0; frame < 60; frame++) {
		await new Promise((resolve) => requestAnimationFrame(resolve));
		if (jumpToEntry(entryId)) return true;
	}
	return false;
}

/** A message to show once its conversation is open (a search hit), consumed by that conversation's view. */
let pendingReveal: { session: string; conversation: number; entryId: number } | undefined;
let revealRequests = 0;
const revealListeners = new Set<() => void>();
export function requestReveal(session: string, conversation: number, entryId: number): void {
	pendingReveal = { session, conversation, entryId };
	revealRequests++;
	for (const listener of [...revealListeners]) listener();
}
/** Changes with every request (a `useSyncExternalStore` source), so an open conversation sees a hit in itself. */
export const revealRequest = {
	subscribe(listener: () => void): () => void {
		revealListeners.add(listener);
		return () => revealListeners.delete(listener);
	},
	count: (): number => revealRequests,
};
/** The pending message of this conversation, taken once its history is there. */
export function takeReveal(session: string, conversation: number, loaded: boolean): number | undefined {
	if (!loaded || pendingReveal?.session !== session || pendingReveal.conversation !== conversation) return undefined;
	const { entryId } = pendingReveal;
	pendingReveal = undefined;
	return entryId;
}

/**
 * Scrolls an entry's item into view and highlights it briefly. False when that entry is not loaded. The transcript
 * renders only the rows near the viewport, so the entry is found in its rows, not in the DOM.
 */
export function jumpToEntry(entryId: number): boolean {
	return revealInTranscripts(entryId);
}

/**
 * How to start a reply to one message: a button that shows on hover (hidden for coarse pointers), and a long press
 * (half a second, without moving) on touch screens. Nothing when replies are off or the item has no entry yet.
 */
function useReply(entryId: number | undefined, name: string) {
	const reply = useContext(ReplyTo);
	const press = useRef<ReturnType<typeof setTimeout>>(undefined);
	if (!reply || entryId === undefined) return { button: null, gesture: {} };
	const start = () => reply({ entryId, name });
	const cancel = () => clearTimeout(press.current);
	return {
		button: (
			<button type="button" className="reply-button" aria-label={`Reply to ${name}`} onClick={start}>
				<ReplyIcon />
			</button>
		),
		gesture: {
			onPointerDown: (event: PointerEvent) => {
				if (event.pointerType !== "touch") return;
				cancel();
				press.current = setTimeout(() => {
					navigator.vibrate?.(10);
					start();
				}, 500);
			},
			onPointerUp: cancel,
			onPointerCancel: cancel,
			onPointerMove: cancel,
		},
	};
}

function str(value: unknown): string {
	return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function relativePath(cwd: string | undefined, path: string): string {
	if (!cwd?.startsWith("/") || !path.startsWith("/")) return path;
	const from = cwd.split("/").filter(Boolean);
	const to = path.split("/").filter(Boolean);
	let shared = 0;
	while (shared < from.length && from[shared] === to[shared]) shared++;
	return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/") || ".";
}

function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** One line of a nested call's arguments: what the call is about (command, path, pattern), else its JSON. */
function callSummary(args: NestedCall["args"], cwd: string | undefined): string {
	if (typeof args === "string") return args.replace(/\s+/g, " ").trim();
	const key = ["command", "path", "pattern", "url", "query", "name", "label", "prompt"].find(
		(name) => typeof args[name] === "string",
	);
	const value =
		key === undefined ? JSON.stringify(args) : key === "path" ? relativePath(cwd, str(args.path)) : str(args[key]);
	return value === "{}" ? "" : value.replace(/\s+/g, " ").trim();
}

function CallState({ status }: { status: NestedCall["status"] }) {
	return status === "running" || status === "pending" ? (
		<span className="spinner" />
	) : status === "done" ? (
		<CheckIcon />
	) : (
		<AlertIcon />
	);
}

/** Rows a running list shows before "Show all"; the newest calls, where the work is. */
const LIVE_CALLS = 8;

/**
 * Calls a tool made to other tools: a list while the tool runs (the newest rows), then collapsed behind
 * "N tool calls" once it settled.
 */
function NestedCalls({ calls, settled }: { calls: readonly NestedCall[]; settled: boolean }) {
	// Opened in the running or the settled state: once the script settles, a list opened while it ran collapses to
	// its summary.
	const [openedAt, setOpenedAt] = useState<boolean>();
	const open = openedAt === settled;
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	const agents = useContext(OneShotAgents);
	const openConversation = useContext(OpenConversation);
	const failed = calls.filter((call) => call.status === "error" || call.status === "interrupted").length;
	const hidden = settled ? calls.length : Math.max(0, calls.length - LIVE_CALLS);
	const shown = open ? calls : settled ? [] : calls.slice(-LIVE_CALLS);
	const count = `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}${failed ? ` · ${failed} failed` : ""}`;
	return (
		<div className="nested">
			{hidden > 0 && (
				<button
					type="button"
					className="tool-link"
					aria-expanded={open}
					onClick={() => setOpenedAt(open ? undefined : settled)}
				>
					{settled ? count : open ? "Show newest calls" : `Show all ${count}`}
				</button>
			)}
			{shown.length > 0 && (
				<ol className="nested-calls">
					{shown.map((call) => {
						const line =
							call.status === "running" ? call.output?.trimEnd().split("\n").at(-1)?.trim() : undefined;
						const agent = call.name === "agent" ? agents.get(call.id) : undefined;
						const summary = callSummary(call.args, cwd);
						return (
							<li
								key={call.id}
								className={`nested-call ${call.status}`}
								style={call.depth ? ({ "--depth": call.depth } as CSSProperties) : undefined}
								title={typeof call.args === "string" ? call.args : JSON.stringify(call.args)}
							>
								<span className="nested-state" title={call.status}>
									<CallState status={call.status} />
								</span>
								<span className="nested-name">{call.name}</span>
								{agent === undefined ? (
									<span className="nested-summary">{summary}</span>
								) : (
									<button
										type="button"
										className="nested-summary nested-open"
										title="Open this agent's transcript"
										onClick={() => openConversation(agent)}
									>
										{summary || "Open agent"}
									</button>
								)}
								<span className="nested-time">
									{call.durationMs !== undefined
										? duration(call.durationMs)
										: call.status === "interrupted"
											? "interrupted"
											: ""}
								</span>
								{call.error && <span className="nested-detail nested-error">{call.error}</span>}
								{line && <span className="nested-detail">{line}</span>}
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}

/** Lines of a script shown before "Show all". */
const SCRIPT_LINES = 6;

/** A code mode script, rendered like a written file (lowlight, `.hljs-*`), clipped to its first lines until expanded. */
function Script({ code }: { code: string }) {
	const [all, setAll] = useState(false);
	const count = code.trimEnd().split("\n").length;
	// Clipping a single line would hide no more than the control takes.
	const long = count > SCRIPT_LINES + 1;
	return (
		<div className={long && !all ? "script clip" : "script"}>
			<CodeBlock tool code={code} language="js" />
			{long && (
				<button type="button" className="tool-link script-more" aria-expanded={all} onClick={() => setAll(!all)}>
					{all ? "Show less" : `Show all ${count} lines`}
				</button>
			)}
		</div>
	);
}

// Items, tools and their images keep their identity while unchanged (transcript.ts), so these memoized components
// skip rendering when a streaming delta changes only the live message.
const Images = memo(function Images({ images }: { images: ImageContent[] }) {
	if (!images.length) return null;
	return (
		<div className="images">
			{images.map((image, index) => (
				<img
					key={`${image.mimeType}-${index}`}
					src={`data:${image.mimeType};base64,${image.data}`}
					alt=""
					decoding="async"
					style={imageBox(image)}
				/>
			))}
		</div>
	);
});

const IMAGE_MAX_HEIGHT = 320;
const imageBoxes = new WeakMap<ImageContent, CSSProperties | undefined>();
/**
 * The box an image takes once decoded (its pixel size within the column's width and `.images img`'s max-height), so
 * decoding never resizes the transcript under the reader. Images keep their identity while unchanged: computed once.
 */
function imageBox(image: ImageContent): CSSProperties | undefined {
	if (imageBoxes.has(image)) return imageBoxes.get(image);
	const size = imageSize(image.data);
	const box = size && {
		width: `min(100%, ${size.width}px, ${(IMAGE_MAX_HEIGHT * size.width) / size.height}px)`,
		aspectRatio: `${size.width} / ${size.height}`,
	};
	imageBoxes.set(image, box);
	return box;
}

const ToolCard = memo(function ToolCard({ tool }: { tool: ToolView }) {
	const [open, setOpen] = useState(false);
	const openConversation = useContext(OpenConversation);
	const openViewer = useContext(OpenViewer);
	const sessionId = useContext(SessionId);
	const cwd = useContext(WorkingDirectory)?.replace(/\/+$/, "");
	const active = tool.status === "running" || tool.status === "pending";
	const sourcePath = str(tool.args.path);
	const path = relativePath(cwd, sourcePath);
	const details = tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details : {};
	const diff = typeof details.diff === "string" ? details.diff : undefined;
	let icon = <ToolIcon />;
	let title = tool.name;
	let summary = "";
	let body: React.ReactNode = null;
	let extra: React.ReactNode = null;
	const openWorkspace = useContext(OpenWorkspaceFile);
	// File tools link into the workspace panel when the path stays inside the working directory.
	const inside = sourcePath && !path.startsWith("/") && path !== "." && !path.split("/").includes("..");
	const workspaceLink = (line?: number) =>
		openWorkspace && inside && tool.status !== "pending" ? (
			<button type="button" className="tool-link" onClick={() => openWorkspace(path, line)}>
				Open in workspace
			</button>
		) : null;
	let targetConversation: number | undefined;
	const reveal = useContext(RevealEntry);
	// Entries the history tools found or read: each one reveals itself in the transcript.
	const historyList = (rows: unknown, field: "snippet" | "preview") =>
		Array.isArray(rows) && rows.length > 0 ? (
			<ul className="history-hits">
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
							<button type="button" className="tool-link" onClick={() => void revealEntry(entry, reveal)}>
								<span className="mono muted">#{entry}</span> {str(hit.author ?? hit.role)}
							</button>{" "}
							<span className="history-snippet">{str(hit[field])}</span>
						</li>,
					];
				})}
			</ul>
		) : null;
	// Completed artifacts and sent files render as a card that opens the shared viewer.
	let card: ReactNode = null;
	switch (tool.name) {
		case "bash": {
			icon = <TerminalIcon />;
			title = "";
			const command = str(tool.args.command);
			summary = command;
			body = (
				<>
					<pre className="tool-command">{command}</pre>
					{tool.output && <pre className="term">{tool.output}</pre>}
				</>
			);
			break;
		}
		case "codemode": {
			icon = <CodeIcon />;
			title = "Code";
			const code = str(tool.args.code);
			summary =
				code
					.split("\n")
					.find((line) => line.trim())
					?.trim() ?? "";
			body = (
				<>
					<Script code={code} />
					{tool.output && (
						<pre className={`term ${tool.status === "error" ? "tool-error" : ""}`}>{tool.output}</pre>
					)}
				</>
			);
			break;
		}
		case "read": {
			icon = <FileIcon />;
			title = "Read";
			const start = typeof tool.args.offset === "number" ? tool.args.offset : 1;
			const range =
				tool.args.offset !== undefined || tool.args.limit !== undefined
					? `:${start}${typeof tool.args.limit === "number" ? `:${start + tool.args.limit - 1}` : ""}`
					: "";
			summary = `${path}${range}`;
			body = tool.output ? <CodeBlock tool code={tool.output} language={path} /> : null;
			extra = workspaceLink(typeof tool.args.offset === "number" ? tool.args.offset : undefined);
			break;
		}
		case "write":
			icon = <FileIcon />;
			title = "Write";
			summary = path;
			body = <CodeBlock tool code={str(tool.args.content)} language={path} />;
			if (tool.status === "error") body = <pre className="code">{tool.output}</pre>;
			else extra = workspaceLink();
			break;
		case "subagent": {
			icon = <BotIcon />;
			const action = str(tool.args.action);
			title = action ? `Subagent ${action}` : "Subagent";
			summary = [str(tool.args.name), str(tool.args.message)].filter(Boolean).join(" · ");
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
			body = (
				<div className="tool-sub">
					{tool.args.message !== undefined && <Markdown text={str(tool.args.message)} />}
					{config && <p className="mono muted">{config}</p>}
					{tool.output &&
						(action === "answer" && tool.status === "done" ? (
							<Markdown text={tool.output} />
						) : (
							<pre className="code">{tool.output}</pre>
						))}
				</div>
			);
			if (action === "spawn" && target !== undefined) targetConversation = target;
			else if (target !== undefined)
				extra = (
					<button type="button" className="tool-link" onClick={() => openConversation(target)}>
						Open {str(details.name)} →
					</button>
				);
			break;
		}
		case "artifact": {
			icon = <SparkIcon size={15} />;
			title = "Artifact";
			summary = typeof details.title === "string" ? details.title : str(tool.args.title);
			body = tool.output ? <pre className="code">{tool.output}</pre> : null;
			if (
				tool.status === "done" &&
				sessionId &&
				typeof details.name === "string" &&
				/^[a-z0-9][a-z0-9_-]{0,63}$/.test(details.name) &&
				typeof details.title === "string" &&
				["html", "svg", "markdown", "text"].includes(String(details.type)) &&
				typeof details.version === "number" &&
				Number.isSafeInteger(details.version) &&
				details.version > 0
			) {
				const artifact = details as ArtifactInfo;
				const urls = artifactUrls(sessionId, artifact);
				card = (
					<FileCard
						icon={<ArtifactIcon />}
						title={artifact.title}
						meta={`${artifact.type.toUpperCase()} · version ${artifact.version}`}
						href={urls.download}
						download={urls.filename}
						onOpen={() => openViewer({ kind: "artifact", artifact })}
					/>
				);
			}
			break;
		}
		case "ports": {
			title = "Ports";
			summary = [
				str(tool.args.action),
				typeof tool.args.port === "number" ? String(tool.args.port) : "",
				str(tool.args.name),
				tool.args.public === true ? "public" : "",
			]
				.filter(Boolean)
				.join(" · ");
			body = tool.output ? <pre className="code">{tool.output}</pre> : null;
			// The forward this call opened: its address, and the public one when it is public.
			const forward =
				details.forward && typeof details.forward === "object" && !Array.isArray(details.forward)
					? (details.forward as Record<string, unknown>)
					: undefined;
			const link = (value: unknown) =>
				typeof value === "string" && /^https?:\/\/(?:fwd|pub)--[0-9a-f]{32}--[a-z0-9]+\.[^/\s]+\/$/.test(value)
					? value
					: undefined;
			const url = link(forward?.url);
			const publicUrl = link(forward?.publicUrl);
			if (tool.status === "done" && (url || publicUrl))
				extra = (
					<>
						{url && (
							<a className="tool-link" href={url} target="_blank" rel="noopener noreferrer">
								Open {str(forward?.name) || `port ${str(forward?.port)}`} →
							</a>
						)}
						{publicUrl && (
							<a className="tool-link" href={publicUrl} target="_blank" rel="noopener noreferrer">
								Public link →
							</a>
						)}
					</>
				);
			break;
		}
		case "send_file":
			icon = <FileIcon />;
			title = "File";
			summary = typeof details.name === "string" ? details.name : path;
			body = tool.output ? <pre className="code">{tool.output}</pre> : null;
			if (
				tool.status === "done" &&
				sessionId &&
				typeof details.id === "string" &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(details.id) &&
				typeof details.name === "string" &&
				typeof details.size === "number" &&
				details.size >= 0
			) {
				const file = { id: details.id, name: details.name, size: details.size };
				card = (
					<FileCard
						icon={<FileIcon />}
						title={file.name}
						meta={fileMeta(file)}
						href={fileUrl(sessionId, file)}
						download={file.name}
						onOpen={() => openViewer({ kind: "file", file })}
					/>
				);
			}
			break;
		case "history_search": {
			icon = <SearchIcon size={15} />;
			title = "History search";
			summary = str(tool.args.query);
			const hits = Array.isArray(details.hits) ? details.hits : [];
			body = (
				<div className="tool-sub">
					{historyList(hits, "snippet") ??
						(tool.output && (
							<pre className={`code ${tool.status === "error" ? "tool-error" : ""}`}>{tool.output}</pre>
						))}
					{details.more === true && <p className="muted">More matches</p>}
				</div>
			);
			break;
		}
		case "history_read": {
			icon = <SearchIcon size={15} />;
			title = "History read";
			const mode = str(tool.args.mode);
			const entries = Array.isArray(details.entries) ? details.entries : [];
			const count = entries.length;
			summary =
				mode === "tail"
					? `${count} ${count === 1 ? "entry" : "entries"} before the last compaction or handoff`
					: mode === "range"
						? `from #${str(tool.args.from)}${tool.args.to === undefined ? "" : ` to #${str(tool.args.to)}`}`
						: `${count} ${count === 1 ? "entry" : "entries"}`;
			body = (
				<div className="tool-sub">
					{historyList(entries, "preview") ??
						(tool.output && (
							<pre className={`code ${tool.status === "error" ? "tool-error" : ""}`}>{tool.output}</pre>
						))}
					{details.truncated === true && <p className="muted">Cut at the output budget</p>}
				</div>
			);
			break;
		}
		case "history_handoff":
			icon = <RefreshIcon />;
			title = "Handoff";
			summary =
				str(tool.args.text)
					.split("\n")
					.find((line) => line.trim()) ?? "";
			body = (
				<div className="tool-sub">
					<Markdown text={str(tool.args.text)} />
					<p className="muted">New context started; earlier history stays searchable.</p>
				</div>
			);
			break;
		case "edit":
			icon = <PencilIcon />;
			title = "Edit";
			summary = path;
			body = diff ? (
				<DiffBlock diff={diff} language={path} />
			) : tool.output ? (
				<pre className="code">{tool.output}</pre>
			) : null;
			if (tool.status !== "error") {
				const first = typeof diff === "string" ? /^[+-]\s*(\d+) /m.exec(diff)?.[1] : undefined;
				extra = workspaceLink(first ? Number(first) : undefined);
			}
			break;
		default:
			summary = Object.keys(tool.args).length ? JSON.stringify(tool.args) : "";
			// Built only when shown: a long transcript has many closed cards.
			body = open ? (
				<>
					{Object.keys(tool.args).length > 0 && <pre className="code">{JSON.stringify(tool.args, null, 2)}</pre>}
					{tool.output && <pre className="code">{tool.output}</pre>}
				</>
			) : null;
	}
	if (card)
		return (
			<div className="tool file-tool">
				{card}
				<Images images={tool.images} />
			</div>
		);
	return (
		<div className={`tool ${tool.status}`}>
			<div className="tool-header">
				<button
					type="button"
					className="tool-head"
					onClick={() =>
						targetConversation !== undefined ? openConversation(targetConversation) : setOpen(!open)
					}
					aria-expanded={targetConversation === undefined ? open : undefined}
					title={targetConversation !== undefined ? `Open subagent ${str(details.name)}` : undefined}
				>
					<span className="tool-icon">{icon}</span>
					{title && <span className="tool-name">{title}</span>}
					<span className="tool-summary">{summary}</span>
					<span className="tool-state" title={tool.status}>
						{active ? (
							<span className="spinner" />
						) : tool.status === "done" ? (
							<CheckIcon />
						) : tool.status === "interrupted" ? (
							"interrupted"
						) : (
							<AlertIcon />
						)}
					</span>
					{targetConversation === undefined && (
						<span className={`chev ${open ? "open" : ""}`}>
							<ChevronIcon size={14} />
						</span>
					)}
				</button>
				{targetConversation !== undefined && (
					<button
						type="button"
						className="tool-expand"
						aria-label="Expand spawn details"
						aria-expanded={open}
						onClick={() => setOpen(!open)}
					>
						<span className={`chev ${open ? "open" : ""}`}>
							<ChevronIcon size={14} />
						</span>
					</button>
				)}
			</div>
			{open && body && <div className="tool-body">{body}</div>}
			{extra}
			{tool.calls && tool.calls.length > 0 && <NestedCalls calls={tool.calls} settled={!active} />}
			<Images images={tool.images} />
		</div>
	);
});

function Thinking({ text, live }: { text: string; live: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`thinking ${live ? "live" : ""}`}>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
				<SparkIcon size={15} />
				<span>{live ? "Thinking…" : "Thought"}</span>
				<span className={`chev ${open ? "open" : ""}`}>
					<ChevronIcon size={14} />
				</span>
			</button>
			{open && <div className="thinking-body">{text}</div>}
		</div>
	);
}

function Assistant({
	entryId,
	message,
	tools,
	streaming,
}: {
	entryId?: number;
	message: AssistantMessage;
	tools: ToolView[];
	streaming: boolean;
}) {
	const reply = useReply(streaming ? undefined : entryId, "Pi");
	const byId = new Map(tools.map((tool) => [tool.id, tool]));
	const parts = message.content;
	const lastText = parts.findLastIndex((part) => part.type === "text" && part.text.trim());
	const firstThinking = parts.findIndex((part) => part.type === "thinking");
	const thinkingText = parts
		.flatMap((part) => (part.type === "thinking" && part.thinking.trim() ? [part.thinking.trim()] : []))
		.join("\n\n");
	const thinkingLive = streaming && parts.at(-1)?.type === "thinking";
	const answer = parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n\n")
		.trim();
	const notice = hasNotice(message, streaming);
	return (
		<div className="assistant" data-entry={entryId} {...reply.gesture}>
			{parts.map((part, index) => {
				const key = `${part.type}-${index}`;
				if (part.type === "thinking")
					return index === firstThinking && thinkingText ? (
						<Thinking key={key} text={thinkingText} live={thinkingLive} />
					) : null;
				if (part.type === "text")
					return !part.text.trim() ? null : (
						<div key={key} className={streaming && index === lastText ? "streaming" : undefined}>
							<Markdown text={part.text} />
							{index === lastText && answer && !streaming && (
								<div className="message-actions">
									<CopyButton text={answer} />
									{reply.button}
								</div>
							)}
						</div>
					);
				if (part.type === "toolCall") {
					const tool = byId.get(part.id) ?? {
						id: part.id,
						name: part.name,
						args: part.arguments ?? {},
						status: "pending" as const,
						output: "",
						images: [],
					};
					return <ToolCard key={part.id} tool={tool} />;
				}
				return null;
			})}
			{notice && (
				<div className={`notice ${message.stopReason === "aborted" ? "stopped" : "error"}`}>
					{message.stopReason === "aborted"
						? "Stopped"
						: message.stopReason === "length"
							? "The response hit the model's length limit"
							: message.errorMessage || "The provider returned an error."}
				</div>
			)}
		</div>
	);
}

/** Whether a response ends with a notice (an error, a stop, the length limit) below its parts. */
function hasNotice(message: AssistantMessage, streaming: boolean): boolean {
	return ["error", "aborted", "length"].includes(message.stopReason) && !streaming;
}

/** The parts a response shows: tool calls, non-empty text, and its first thinking part when it has thinking text. */
function visibleParts(message: AssistantMessage): AssistantMessage["content"] {
	const firstThinking = message.content.findIndex((part) => part.type === "thinking");
	const thinking = message.content.some((part) => part.type === "thinking" && part.thinking.trim());
	return message.content.filter(
		(part, index) =>
			part.type === "toolCall" ||
			(part.type === "text" && part.text.trim()) ||
			(part.type === "thinking" && index === firstThinking && thinking),
	);
}

/** Whether an item's first and last visible blocks are tool calls (a tool call ending one response and one starting
 * the next stack like parallel calls, without the gap between items). */
function toolEdges(item: Item): { starts: boolean; ends: boolean } {
	if (item.type === "tool") return { starts: true, ends: true };
	if (item.type !== "assistant") return { starts: false, ends: false };
	const visible = visibleParts(item.message);
	return {
		starts: visible[0]?.type === "toolCall",
		ends: !hasNotice(item.message, item.streaming) && visible.at(-1)?.type === "toolCall",
	};
}

/** Height of images whose boxes are known from their headers (`imageBox`), at most `width` wide. */
function imagesHeight(images: readonly ImageContent[], width: number): number {
	let height = 0;
	for (const image of images) {
		const size = imageSize(image.data);
		if (size)
			height +=
				(Math.min(width, size.width, (IMAGE_MAX_HEIGHT * size.width) / size.height) * size.height) / size.width;
	}
	return height;
}

/**
 * What a row's height depends on, for estimating rows never rendered (`RowEstimator`): its kind (the shape of its
 * item), its text length, and its images, whose boxes are exact.
 */
function rowFeatures(row: TranscriptRow, width: number): RowFeatures {
	const { item } = row;
	const spacing = row.first ? "first" : row.joined ? "joined" : "";
	switch (item.type) {
		case "user":
			return {
				kind: ["user", item.author || item.peer ? "named" : "", item.images.length ? "images" : "", spacing].join(
					":",
				),
				text: item.text.length,
				fixed: imagesHeight(item.images, width),
			};
		case "assistant": {
			const parts = visibleParts(item.message);
			const shape = parts.map((part) => (part.type === "toolCall" ? "t" : part.type === "thinking" ? "k" : "x"));
			const images = item.tools.flatMap((tool) => tool.images);
			return {
				// The parts' order and kinds (thinking, text, tool calls, at most four described), and whether it ends.
				kind: [
					"assistant",
					shape.slice(0, 4).join("") + (shape.length > 4 ? `+${shape.length - 4}` : ""),
					item.streaming ? "live" : hasNotice(item.message, item.streaming) ? "notice" : "",
					images.length ? "images" : "",
					spacing,
				].join(":"),
				text: parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0),
				fixed: imagesHeight(images, width),
			};
		}
		case "tool":
			return {
				kind: ["tool", item.tool.images.length ? "images" : "", spacing].join(":"),
				text: 0,
				fixed: imagesHeight(item.tool.images, width),
			};
		case "failure":
			return { kind: `failure:${spacing}`, text: item.text.length, fixed: 0 };
		case "marker":
			return { kind: `marker:${spacing}`, text: 0, fixed: 0 };
		case "gap":
			return { kind: `gap:${spacing}`, text: 0, fixed: 0 };
	}
}

/**
 * Estimates for transcript rows never rendered, learned from the rows that were (`RowEstimator`); shared by every
 * transcript, since they share the stylesheet. A row of a kind not measured yet starts at about two lines of text.
 */
export const rowEstimates = new RowEstimator<TranscriptRow>(rowFeatures, 120);

function Report({ name, status, text }: { name: string; status: string; text: string }) {
	const [open, setOpen] = useState(false);
	const failed = status.startsWith("failed");
	const verb = failed ? "failed" : status === "question" ? "asks" : status === "note" ? "notes" : "answered";
	return (
		<div className={`report ${failed ? "failed" : ""} ${status === "question" ? "question" : ""}`}>
			<button type="button" className="report-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<BotIcon />
				<span>
					<strong>{name}</strong> {verb}
				</span>
				<span className={`chev ${open ? "open" : ""}`}>
					<ChevronIcon size={14} />
				</span>
			</button>
			{text && (
				<div className={open ? "report-body" : "report-body clamp"}>{failed ? text : <Markdown text={text} />}</div>
			)}
		</div>
	);
}

/** A person's message: an input, or a display-only entry (chat). People's messages can be replied to. */
function UserMessage({ item }: { item: Extract<Item, { type: "user" }> }) {
	const openPeer = useContext(OpenPeerConversation);
	const reveal = useContext(RevealEntry);
	const peer = item.peer;
	const reply = useReply(item.author ? item.entryId : undefined, item.author?.name ?? "");
	return (
		<div
			className={`user ${item.author?.kind === "guest" ? "guest-message" : ""} ${item.chat ? "chat-message" : ""}`}
			data-entry={item.entryId}
		>
			{reply.button}
			<div className="bubble" {...reply.gesture}>
				{item.replyTo && (
					<button
						type="button"
						className="reply-quote"
						title="Show the message this answers"
						onClick={() => item.replyTo && void revealEntry(item.replyTo.entryId, reveal)}
					>
						<strong>{item.replyTo.name}</strong> {item.replyTo.excerpt}
					</button>
				)}
				{item.author && (
					<div
						className="speaker"
						style={
							item.author.kind === "guest"
								? {
										color: `hsl(${[...item.author.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0)} 65% 55%)`,
									}
								: undefined
						}
					>
						{item.author.kind === "owner" ? item.author.name : `${item.author.name} · guest`}
						{item.chat && " · chat"}
					</div>
				)}
				{peer &&
					(openPeer ? (
						<button
							type="button"
							className="speaker footer-action"
							aria-label={`Open conversation ${peer.title.trim() || "Conversation"}`}
							onClick={() => openPeer(peer.id)}
						>
							{peer.title.trim() || "Conversation"} · agent
						</button>
					) : (
						<div className="speaker" title={`Agent conversation ${peer.id}`}>
							{peer.title.trim() || "Conversation"} · agent
						</div>
					))}
				{item.peer ? <Markdown text={item.text} /> : item.text}
				{item.files.length > 0 && (
					<div className="bubble-files">
						{item.files.map((file) => (
							<span key={file}>{file}</span>
						))}
					</div>
				)}
				<Images images={item.images} />
				{item.note && <div className="bubble-note">{item.note}</div>}
			</div>
		</div>
	);
}

const ItemView = memo(function ItemView({ item }: { item: Item }) {
	switch (item.type) {
		case "user": {
			// Subagents' messages (reports, questions, notes), from their entry data.
			if (item.agent) return <Report name={item.agent.from.name} status={item.agent.intent} text={item.text} />;
			// LEGACY: reports from before they were entries, recognized by their first line.
			const report = !item.author && !item.peer && /^\[subagent (\S+) ([^\]]*)\] ?([\s\S]*)$/.exec(item.text);
			if (report) return <Report name={report[1] ?? ""} status={report[2] ?? ""} text={report[3] ?? ""} />;
			return <UserMessage item={item} />;
		}
		case "assistant":
			return (
				<Assistant entryId={item.entryId} message={item.message} tools={item.tools} streaming={item.streaming} />
			);
		case "tool":
			return (
				<div className="assistant">
					<ToolCard tool={item.tool} />
				</div>
			);
		case "failure":
			return <output className="notice error">{item.text}</output>;
		case "marker":
			return (
				<details className="marker">
					<summary>{item.label}</summary>
					{item.detail && <Markdown text={item.detail} />}
				</details>
			);
		case "gap":
			return <GapRow item={item} />;
	}
});

/** A transcript row: an item, and its spacing to the item before it (see `toolEdges`). */
export type TranscriptRow = { key: string; entryId?: number; item: Item; first: boolean; joined: boolean };

/** The rows of a transcript's items. Items keep their identity while unchanged, and so do their rows. */
const rowsOf = new WeakMap<Item, { previous: Item | undefined; row: TranscriptRow }>();
export function transcriptRows(items: readonly Item[]): TranscriptRow[] {
	return items.map((item, index) => {
		const previous = items[index - 1];
		const cached = rowsOf.get(item);
		if (cached && cached.previous === previous) return cached.row;
		const row: TranscriptRow = {
			key: item.key,
			...("entryId" in item && item.entryId !== undefined ? { entryId: item.entryId } : {}),
			item,
			first: index === 0,
			joined: previous !== undefined && toolEdges(previous).ends && toolEdges(item).starts,
		};
		rowsOf.set(item, { previous, row });
		return row;
	});
}

/** Rows arriving together fade in one after another, this far apart, all within `ENTER_LAST`. */
const ENTER_STAGGER = 45;
const ENTER_LAST = 360;
/** How long a row counts as arriving (its animation's length and delay): mounted again later, it does not animate. */
const ENTER_FOR = 1_000;

/**
 * Rows that just arrived at the end of the transcript, with their animation delays: new messages fade in instead of
 * appearing at once (a burst after reconnecting one after another). Only rows appended after the previous last row
 * while the list grows: not the first rows (opening a conversation, the transcript kept on the device), not older
 * history above, not a row replaced in place (a streaming answer committed, a sent message the server now shows), and
 * not a row the virtual list mounts again while scrolling.
 */
function useArriving(rows: readonly TranscriptRow[]): ReadonlyMap<string, number> {
	const state = useRef<{ rows: readonly TranscriptRow[]; arriving: Map<string, { delay: number; until: number }> }>(
		undefined,
	);
	const now = performance.now();
	const current = state.current;
	if (!current) {
		state.current = { rows, arriving: new Map() };
		return new Map();
	}
	if (current.rows !== rows) {
		const last = current.rows.at(-1);
		if (last && rows.length > current.rows.length) {
			let at = rows.length - 1;
			while (at >= 0 && rows[at]?.key !== last.key) at--;
			const added = at >= 0 ? rows.slice(at + 1) : [];
			added.forEach((row, index) => {
				if (current.arriving.has(row.key)) return;
				const delay = Math.min(index * ENTER_STAGGER, ENTER_LAST);
				current.arriving.set(row.key, { delay, until: now + delay + ENTER_FOR });
			});
		}
		current.rows = rows;
	}
	const delays = new Map<string, number>();
	for (const [key, { delay, until }] of current.arriving) {
		if (until < now) current.arriving.delete(key);
		else delays.set(key, delay);
	}
	return delays;
}

// The composer re-renders App on every keypress; a long transcript must only
// re-render when the view changes. Only the rows in `range` are rendered (use-chat-scroll.ts); spacers stand for the
// others.
export const Messages = memo(function Messages({
	transcript,
	rows,
	list,
	range,
	stopped = false,
	earlier,
	onEarlier,
}: {
	transcript: Transcript;
	rows: readonly TranscriptRow[];
	list: TranscriptScroll;
	range: RowRange;
	stopped?: boolean;
	/**
	 * The loaded history's top edge: older history exists ("more"), is being fetched ("loading"), or every page was
	 * loaded ("start").
	 */
	earlier?: "more" | "loading" | "start";
	onEarlier?: () => void;
}) {
	const spacers = list.spacers(range);
	const arriving = useArriving(rows);
	return (
		<div className="messages">
			{/* One height in every state: the edge changing never moves the transcript under the reader. It loads ahead
			    of the reader (use-chat-scroll.ts), so the button is a fallback. */}
			{earlier === "start" ? (
				<div className="history-edge">Start of conversation</div>
			) : (
				earlier && (
					<button
						type="button"
						className={`history-edge earlier${earlier === "loading" ? " loading" : ""}`}
						disabled={earlier === "loading"}
						aria-busy={earlier === "loading"}
						onClick={onEarlier}
					>
						<span className="spinner" aria-hidden="true" />
						Earlier messages
					</button>
				)
			)}
			<div className="rows" ref={list.listRef} data-rows={rows.length}>
				<div className="row-space" ref={list.topRef} style={{ height: spacers.before }} />
				{rows.slice(range.start, range.end + 1).map((row) => {
					const delay = arriving.get(row.key);
					return (
						<div
							key={row.key}
							className={[
								"row",
								row.first ? "first" : row.joined ? "joined" : "",
								delay === undefined ? "" : "arriving",
							]
								.filter(Boolean)
								.join(" ")}
							style={delay ? { animationDelay: `${delay}ms` } : undefined}
							data-row={row.key}
							ref={list.rowRef}
						>
							<ItemView item={row.item} />
						</div>
					);
				})}
				<div className="row-space" ref={list.bottomRef} style={{ height: spacers.after }} />
			</div>
			{stopped && !transcript.busy && <output className="notice stopped">Stopped</output>}
			{transcript.working && (
				<output className="working" aria-label="Working">
					<span />
					<span />
					<span />
				</output>
			)}
			{transcript.compactions.map((compaction) => (
				<output key={compaction.id} className="notice">
					{compaction.blocking ? "Compacting context…" : "Compacting context in background…"}
					{compaction.retry && ` Retrying: ${compaction.retry.error.slice(0, 200)}`}
				</output>
			))}
			{transcript.retry && (
				<div className="notice">Provider error, retrying… {transcript.retry.error.slice(0, 200)}</div>
			)}
		</div>
	);
});
