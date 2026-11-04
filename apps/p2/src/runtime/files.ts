/** A display filename, never a path or a raw HTTP header value. */
export function safeFileName(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? "";
	const safe = base
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.replace(/^\.+/, "")
		.slice(-120);
	return safe || "file";
}

export type DownloadInfo = { id: string; name: string; size: number };
export type FilePreview = { kind: "text" | "image" | "audio" | "video"; mimeType: string };

const previewTypes: Record<string, FilePreview> = {
	txt: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	md: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	markdown: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	js: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	jsx: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	ts: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	tsx: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	json: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	css: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	html: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	htm: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	xml: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	yaml: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	yml: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	sh: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	py: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	rs: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	go: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	java: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	c: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	h: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	cpp: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	sql: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	log: { kind: "text", mimeType: "text/plain; charset=utf-8" },
	png: { kind: "image", mimeType: "image/png" },
	jpg: { kind: "image", mimeType: "image/jpeg" },
	jpeg: { kind: "image", mimeType: "image/jpeg" },
	gif: { kind: "image", mimeType: "image/gif" },
	webp: { kind: "image", mimeType: "image/webp" },
	avif: { kind: "image", mimeType: "image/avif" },
	mp3: { kind: "audio", mimeType: "audio/mpeg" },
	m4a: { kind: "audio", mimeType: "audio/mp4" },
	aac: { kind: "audio", mimeType: "audio/aac" },
	wav: { kind: "audio", mimeType: "audio/wav" },
	oga: { kind: "audio", mimeType: "audio/ogg" },
	ogg: { kind: "audio", mimeType: "audio/ogg" },
	flac: { kind: "audio", mimeType: "audio/flac" },
	mp4: { kind: "video", mimeType: "video/mp4" },
	m4v: { kind: "video", mimeType: "video/mp4" },
	webm: { kind: "video", mimeType: "video/webm" },
	ogv: { kind: "video", mimeType: "video/ogg" },
	mov: { kind: "video", mimeType: "video/quicktime" },
};

/** A conservative extension allowlist; active formats such as SVG never execute. */
export function filePreview(name: string): FilePreview | undefined {
	const extension = name.toLowerCase().split(".").pop();
	return extension ? previewTypes[extension] : undefined;
}
