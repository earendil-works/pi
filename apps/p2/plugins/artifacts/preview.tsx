import { artifactUrls, Markdown, ViewerShell } from "@p2/app/v1/web";
import { type Ref, useEffect, useRef, useState } from "react";
import type { ArtifactInfo } from "./contract.ts";

type Diagnostic = { level: "ready" | "error" | "warn" | "csp" | "webgl"; message: string };
/** What a preview frame posts on the diagnostic channel: a diagnostic, or its content height (`store.ts`). */
type FrameMessage = Diagnostic | { level: "size"; height: number };

/** A message from a preview frame (untrusted: the artifact's own script can post anything). */
function frameMessage(value: unknown): FrameMessage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const data = value as Record<string, unknown>;
	if (data.channel !== "p2-artifact-diagnostic") return;
	if (data.level === "size")
		return typeof data.height === "number" && Number.isFinite(data.height) && data.height >= 0
			? { level: "size", height: data.height }
			: undefined;
	if (!["ready", "error", "warn", "csp", "webgl"].includes(String(data.level)) || typeof data.message !== "string")
		return;
	return { level: data.level as Diagnostic["level"], message: data.message.slice(0, 4000) };
}

/** Calls `receive` with each message the frame posts on the diagnostic channel. */
function useFrameMessages(
	frame: { readonly current: HTMLIFrameElement | null },
	receive: (message: FrameMessage) => void,
): void {
	const latest = useRef(receive);
	latest.current = receive;
	useEffect(() => {
		const listener = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			const message = frameMessage(event.data);
			if (message) latest.current(message);
		};
		window.addEventListener("message", listener);
		return () => window.removeEventListener("message", listener);
	}, [frame]);
}

/** A text or Markdown artifact's content from its route: undefined while it loads, or the error. */
function useArtifactText(url: string | undefined): { content?: string; error?: string } {
	const [state, setState] = useState<{ url?: string; content?: string; error?: string }>({});
	useEffect(() => {
		if (!url) return;
		const abort = new AbortController();
		void fetch(url, { credentials: "same-origin", cache: "no-store", signal: abort.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error(`Could not open artifact (${response.status})`);
				const content = await response.text();
				setState({ url, content });
			})
			.catch((caught: unknown) => {
				if (!abort.signal.aborted)
					setState({ url, error: caught instanceof Error ? caught.message : "Could not open artifact" });
			});
		return () => abort.abort();
	}, [url]);
	return state.url === url ? state : {};
}

/** The sandboxed frame of an HTML or SVG preview: an opaque origin, and the route's CSP sandbox on top. */
function ArtifactFrame({
	url,
	title,
	frame,
	height,
}: {
	url: string;
	title: string;
	frame: Ref<HTMLIFrameElement>;
	height?: number;
}) {
	return (
		<iframe
			// A new frame per artifact: changing a frame's src would add a history entry.
			key={url}
			ref={frame}
			title={title}
			src={url}
			sandbox="allow-scripts allow-modals allow-pointer-lock"
			referrerPolicy="no-referrer"
			style={height === undefined ? undefined : { height }}
		/>
	);
}

export function ArtifactPanel({
	sessionId,
	artifact,
	onClose,
}: {
	sessionId: string;
	artifact: ArtifactInfo;
	onClose: () => void;
}) {
	const { view: url, download: downloadUrl, filename } = artifactUrls(sessionId, artifact);
	const document = artifact.type === "markdown" || artifact.type === "text";
	const frame = useRef<HTMLIFrameElement>(null);
	const { content, error } = useArtifactText(document ? url : undefined);
	const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new preview starts without the previous one's diagnostics.
	useEffect(() => {
		setDiagnostics([]);
		setDiagnosticsOpen(false);
	}, [url]);

	useFrameMessages(frame, (next) => {
		if (next.level === "size") return;
		setDiagnostics((current) => [...current.slice(-49), next]);
		if (next.level !== "ready") setDiagnosticsOpen(true);
	});

	const problems = diagnostics.filter((entry) => entry.level !== "ready").length;
	return (
		<ViewerShell
			title={artifact.title}
			subtitle={`${artifact.type} · version ${artifact.version}`}
			content={document ? "document" : "preview"}
			onClose={onClose}
			actions={
				<>
					<a className="text-action" href={downloadUrl} download={filename}>
						Download
					</a>
					<a className="text-action" href={url} target="_blank" rel="noreferrer">
						Open tab
					</a>
				</>
			}
			footer={
				!document &&
				diagnostics.length > 0 && (
					<div className={`artifact-diagnostics ${problems ? "has-errors" : ""}`}>
						<button type="button" onClick={() => setDiagnosticsOpen(!diagnosticsOpen)}>
							<span>
								{problems
									? `${problems} preview issue${problems === 1 ? "" : "s"}`
									: "Preview diagnostics ready"}
							</span>
							<span>{diagnosticsOpen ? "Hide" : "Show"}</span>
						</button>
						{diagnosticsOpen && (
							<div>
								{diagnostics.map((entry, index) => (
									<p key={`${entry.level}-${index}`}>
										<strong>{entry.level}</strong> {entry.message}
									</p>
								))}
							</div>
						)}
					</div>
				)
			}
		>
			{error ? (
				<div className="notice error">{error}</div>
			) : document ? (
				content === undefined ? (
					<div className="spinner large" />
				) : artifact.type === "markdown" ? (
					<Markdown text={content} />
				) : (
					<pre>{content}</pre>
				)
			) : (
				<ArtifactFrame url={url} title={artifact.title} frame={frame} />
			)}
		</ViewerShell>
	);
}

/**
 * The heights inline frames last reported, by URL (versions are immutable), so a row the transcript mounts again
 * keeps its size instead of starting at `FRAME_HEIGHT`.
 */
const frameHeights = new Map<string, number>();
const FRAME_HEIGHTS = 256;
/** A frame's height before it reports one. */
const FRAME_HEIGHT = 150;

/**
 * An artifact version rendered at its tool call site, below the card (`inline: true`): Markdown and text as in the
 * viewer; HTML and SVG in the viewer's sandboxed frame, sized to the content height it reports after drawings were
 * scaled to its width (`store.ts`). CSS caps it at about 70vh: taller HTML scrolls inside the frame, an SVG scales
 * down to fit. Rendered for every viewer of the session (owner decision).
 */
export function InlineArtifact({ sessionId, artifact }: { sessionId: string; artifact: ArtifactInfo }) {
	const url = artifactUrls(sessionId, artifact).view;
	const document = artifact.type === "markdown" || artifact.type === "text";
	const text = useArtifactText(document ? url : undefined);
	const [available, setAvailable] = useState<{ url: string; ok: boolean }>();
	const frame = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(() => frameHeights.get(url));

	// The frame would show the route's bare 404 text: check the version first.
	useEffect(() => {
		if (document) return;
		const abort = new AbortController();
		void fetch(url, { method: "HEAD", credentials: "same-origin", cache: "no-store", signal: abort.signal })
			.then((response) => setAvailable({ url, ok: response.ok }))
			.catch(() => {
				if (!abort.signal.aborted) setAvailable({ url, ok: false });
			});
		return () => abort.abort();
	}, [document, url]);

	useFrameMessages(frame, (message) => {
		if (message.level !== "size") return;
		const next = Math.min(Math.ceil(message.height), 100_000);
		frameHeights.delete(url);
		frameHeights.set(url, next);
		if (frameHeights.size > FRAME_HEIGHTS) frameHeights.delete(frameHeights.keys().next().value ?? "");
		setHeight(next);
	});

	const unavailable = document ? text.error !== undefined : available?.url === url && !available.ok;
	return (
		<div className={`inline-artifact ${artifact.type}`} data-artifact={`${artifact.name}:${artifact.version}`}>
			{unavailable ? (
				<div className="notice error">Artifact unavailable</div>
			) : document ? (
				text.content === undefined ? (
					<div className="spinner" />
				) : artifact.type === "markdown" ? (
					<Markdown text={text.content} />
				) : (
					<pre>{text.content}</pre>
				)
			) : (
				<ArtifactFrame url={url} title={artifact.title} frame={frame} height={height ?? FRAME_HEIGHT} />
			)}
		</div>
	);
}
