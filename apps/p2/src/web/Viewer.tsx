import { createContext, type ReactNode, useEffect, useRef, useState } from "react";
import { type DownloadInfo, filePreview } from "../runtime/files.ts";
import { useScrollMemory, useShownModal } from "../runtime/web.tsx";
import { CodeBlock } from "./Code.tsx";
import { CloseIcon, DownloadIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { inPage } from "./navigation.ts";

// One full-screen viewer for what a conversation hands the user: sent files today. It never executes anything (html
// artifacts run in their own panes, plugins/artifacts).
export type ViewerItem = { kind: "file"; file: DownloadInfo };
/** Opens an item explicitly; tool updates and reconnects never open the viewer. */
export const OpenViewer = createContext<(item: ViewerItem) => void>(() => {});
/**
 * The address that opens an item's viewer in this conversation, for links a modified click, the middle button or "Open
 * in new tab" open in another tab (`routeHref`); undefined where no viewer is provided.
 */
export const ViewerHref = createContext<(item: ViewerItem) => string | undefined>(() => undefined);

function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "MD · 4.2 KB": extension and size, for cards and the viewer header. */
export function fileMeta(file: DownloadInfo): string {
	const extension = file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() : undefined;
	return `${extension ? `${extension} · ` : ""}${fileSize(file.size)}`;
}

export function fileUrl(sessionId: string, file: DownloadInfo): string {
	return `/download?${new URLSearchParams({ session: sessionId, id: file.id })}`;
}

/**
 * Transcript card: the body opens the viewer (a link to `openHref` when there is one, so it also opens in another tab),
 * the separate button downloads. With `thumbnail` (the file's bytes) a raster image or video named `download` shows
 * above the row, and opens the viewer too.
 */
export function FileCard({
	icon,
	title,
	meta,
	href,
	download,
	thumbnail,
	openHref,
	onOpen,
}: {
	icon: ReactNode;
	title: string;
	meta: string;
	href: string;
	download: string;
	thumbnail?: string;
	openHref?: string;
	onOpen: () => void;
}) {
	const media = thumbnail === undefined ? undefined : filePreview(download)?.kind;
	return (
		<div className="file-card">
			{(media === "image" || media === "video") && (
				// The row below opens the same viewer: this second opener stays out of the tab order and the reading.
				<FileOpener className="file-card-thumbnail" openHref={openHref} onOpen={onOpen}>
					{media === "image" ? (
						<img src={thumbnail} alt="" decoding="async" loading="lazy" />
					) : (
						// A start offset makes WebKit paint the first frame without playing.
						<video src={`${thumbnail}#t=0.1`} muted playsInline preload="metadata" />
					)}
				</FileOpener>
			)}
			<div className="file-card-row">
				<FileOpener className="file-card-main" openHref={openHref} onOpen={onOpen} label={`Open ${title}`}>
					<span className="file-card-icon">{icon}</span>
					<span className="file-card-text">
						<strong>{title}</strong>
						<small>{meta}</small>
					</span>
				</FileOpener>
				<a className="file-card-download" href={href} download={download} aria-label={`Download ${title}`}>
					<DownloadIcon />
				</a>
			</div>
		</div>
	);
}

/**
 * A part of a file card that opens the viewer: a link to `openHref` when there is one, else a button. Without `label`
 * it is a duplicate opener, hidden from the tab order and screen readers.
 */
function FileOpener({
	className,
	openHref,
	onOpen,
	label,
	children,
}: {
	className: string;
	openHref?: string;
	onOpen: () => void;
	label?: string;
	children: ReactNode;
}) {
	const extra = label === undefined ? { tabIndex: -1, "aria-hidden": true } : { "aria-label": label };
	return openHref === undefined ? (
		<button type="button" className={className} onClick={onOpen} {...extra}>
			{children}
		</button>
	) : (
		<a className={className} href={openHref} onClick={inPage(onOpen)} {...extra}>
			{children}
		</a>
	);
}

export function ViewerShell({
	title,
	subtitle,
	actions,
	content,
	footer,
	onClose,
	children,
}: {
	title: string;
	subtitle: string;
	actions?: ReactNode;
	/** Content area modifier: `document` scrolls a centred column, `preview` fills, `media` centres. */
	content: "document" | "preview" | "media";
	footer?: ReactNode;
	onClose: () => void;
	children: ReactNode;
}) {
	const area = useRef<HTMLDivElement>(null);
	useShownModal();
	useScrollMemory(area);
	useEffect(() => {
		// Cancelled, so a CloseWatcher (navigation.ts) doesn't take the same Escape as Back.
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);
	return (
		<div className="viewer-layer">
			<section className="viewer-panel" role="dialog" aria-modal="true" aria-label={title}>
				<header className="viewer-head">
					<div>
						<strong>{title}</strong>
						<span>{subtitle}</span>
					</div>
					{actions}
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close viewer">
						<CloseIcon />
					</button>
				</header>
				<div className={`viewer-content ${content}`} ref={area}>
					{children}
				</div>
				{footer}
			</section>
		</div>
	);
}

/** Conservative preview of a stored file: text, raster images and media only; never executes. */
export function DownloadPreview({ url, name, size }: { url: string; name: string; size: number }) {
	const preview = filePreview(name);
	const markdown = /\.(md|markdown)$/i.test(name);
	const [text, setText] = useState<string>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		if (preview?.kind !== "text" || size > 1024 * 1024) return;
		const abort = new AbortController();
		setText(undefined);
		setError(undefined);
		void fetch(url, { credentials: "same-origin", cache: "no-store", signal: abort.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error(`Could not preview file (${response.status})`);
				setText(await response.text());
			})
			.catch((caught: unknown) => {
				if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not preview file");
			});
		return () => abort.abort();
	}, [preview?.kind, size, url]);
	if (!preview) return <p className="notice">No preview for this file type. Download it instead.</p>;
	if (preview.kind === "text") {
		if (size > 1024 * 1024) return <p className="notice">Text preview is limited to 1 MiB. Download it instead.</p>;
		if (error) return <p className="notice error">{error}</p>;
		if (text === undefined) return <div className="spinner large" />;
		return markdown ? <Markdown text={text} /> : <CodeBlock code={text} language={name} />;
	}
	if (preview.kind === "image") return <img className="file-media" src={url} alt={name} />;
	if (preview.kind === "audio")
		return (
			// biome-ignore lint/a11y/useMediaCaption: exported files have no caption sidecar to attach.
			<audio className="file-media" src={url} controls preload="metadata" />
		);
	return (
		// biome-ignore lint/a11y/useMediaCaption: exported files have no caption sidecar to attach.
		<video className="file-media" src={url} controls preload="metadata" playsInline />
	);
}

export function FilePanel({
	sessionId,
	file,
	onClose,
}: {
	sessionId: string;
	file: DownloadInfo;
	onClose: () => void;
}) {
	const url = fileUrl(sessionId, file);
	const kind = filePreview(file.name)?.kind;
	return (
		<ViewerShell
			title={file.name}
			subtitle={fileMeta(file)}
			content={kind === "text" ? "document" : "media"}
			onClose={onClose}
			actions={
				<a className="text-action" href={url} download={file.name}>
					Download
				</a>
			}
		>
			<DownloadPreview url={url} name={file.name} size={file.size} />
		</ViewerShell>
	);
}
