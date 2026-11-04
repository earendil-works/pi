import { artifactUrls, Markdown, ViewerShell } from "@p2/app/v1/web";
import { useEffect, useRef, useState } from "react";
import type { ArtifactInfo } from "./contract.ts";

type Diagnostic = { level: "ready" | "error" | "warn" | "csp" | "webgl"; message: string };

function diagnostic(value: unknown): Diagnostic | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const data = value as Record<string, unknown>;
	if (
		data.channel !== "p2-artifact-diagnostic" ||
		!["ready", "error", "warn", "csp", "webgl"].includes(String(data.level)) ||
		typeof data.message !== "string"
	)
		return;
	return { level: data.level as Diagnostic["level"], message: data.message.slice(0, 4000) };
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
	const [content, setContent] = useState<string>();
	const [error, setError] = useState<string>();
	const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new preview starts without the previous one's diagnostics.
	useEffect(() => {
		setDiagnostics([]);
		setDiagnosticsOpen(false);
	}, [url]);

	useEffect(() => {
		const abort = new AbortController();
		if (document) {
			setContent(undefined);
			setError(undefined);
			void fetch(url, { credentials: "same-origin", cache: "no-store", signal: abort.signal })
				.then(async (response) => {
					if (!response.ok) throw new Error(`Could not open artifact (${response.status})`);
					setContent(await response.text());
				})
				.catch((caught: unknown) => {
					if (!abort.signal.aborted)
						setError(caught instanceof Error ? caught.message : "Could not open artifact");
				});
		}
		return () => abort.abort();
	}, [document, url]);

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			const next = diagnostic(event.data);
			if (!next) return;
			setDiagnostics((current) => [...current.slice(-49), next]);
			if (next.level !== "ready") setDiagnosticsOpen(true);
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, []);

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
				<iframe
					// A new frame per artifact: changing a frame's src would add a history entry.
					key={url}
					ref={frame}
					title={artifact.title}
					src={url}
					sandbox="allow-scripts allow-modals allow-pointer-lock"
					referrerPolicy="no-referrer"
				/>
			)}
		</ViewerShell>
	);
}
