// The owner's traces in the page: a search (the earliest span's name, attributes, errors, a time window), the traces
// found (newest first, more by cursor), and one trace as a tree of spans with their lengths on the trace's timeline,
// attributes, events and links (a link opens its trace). The Traces view's pane and the Settings section show it.
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { errorText, useObject } from "@p2/app/v1/web";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { MAX_FILTERS, type Span, type Trace, type TraceQuery, type TraceSummary, Traces } from "./contract.ts";

/** The windows a search may look back over, in milliseconds (0: all the store keeps). */
const WINDOWS = [
	{ label: "15 min", ms: 15 * 60_000 },
	{ label: "1 hour", ms: 60 * 60_000 },
	{ label: "24 hours", ms: 24 * 60 * 60_000 },
	{ label: "7 days", ms: 0 },
] as const;

/**
 * The traces browser: the search and its results, and the trace `open` (one at a time on narrow panes). Where a trace
 * opens is its container's: the pane's own state, a layer of the Settings sheet (Back closes it).
 */
export function TracesBrowser({
	open,
	onOpen,
	onBack,
}: {
	open: string | undefined;
	onOpen: (traceId: string) => void;
	onBack: () => void;
}) {
	return (
		<div className="traces-shell">
			<div className={`traces ${open ? "has-trace" : ""}`}>
				<TraceSearch open={open} onOpen={onOpen} />
				{open && <TraceDetail traceId={open} onOpen={onOpen} onBack={onBack} />}
			</div>
		</div>
	);
}

/** The search form and the traces found. */
function TraceSearch({ open, onOpen }: { open: string | undefined; onOpen: (traceId: string) => void }) {
	const traces = useObject(Traces, {}, { variant: "owner" });
	const [name, setName] = useState("");
	const [attributes, setAttributes] = useState("");
	const [errors, setErrors] = useState(false);
	const [window, setWindow] = useState<number>(WINDOWS[1].ms);
	const [found, setFound] = useState<{ traces: TraceSummary[]; cursor?: string; query: TraceQuery }>();
	const [message, setMessage] = useState<string>();
	const [loading, setLoading] = useState(false);

	const search = useCallback(
		async (query: TraceQuery, more: TraceSummary[]) => {
			if (!traces) return;
			setLoading(true);
			setMessage(undefined);
			try {
				const page = await traces.findTraces(query, BACKGROUND_CONTEXT);
				setFound({
					traces: [...more, ...page.traces],
					...(page.cursor === undefined ? {} : { cursor: page.cursor }),
					query,
				});
			} catch (error) {
				setMessage(errorText(error));
			} finally {
				setLoading(false);
			}
		},
		[traces],
	);

	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		const filters = parseAttributes(attributes);
		if (typeof filters === "string") return setMessage(filters);
		void search(
			{
				...(name.trim() ? { name: name.trim() } : {}),
				...(Object.keys(filters).length ? { attributes: filters } : {}),
				...(errors ? { errors: true } : {}),
				...(window ? { startMin: Date.now() - window } : {}),
				limit: 30,
			},
			[],
		);
	};
	// The newest hour's traces as soon as the object is live.
	// biome-ignore lint/correctness/useExhaustiveDependencies: searches once per object, with the form as it starts.
	useEffect(() => {
		if (traces && !found) submit();
	}, [traces]);

	return (
		<section className="traces-search" aria-label="Traces">
			<form className="traces-form" onSubmit={submit}>
				<input
					className="input"
					aria-label="Span name"
					placeholder="First span's name (chord.hold, pi.durable.submit…)"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<input
					className="input"
					aria-label="Attributes"
					placeholder="Attributes: key=value, …"
					value={attributes}
					onChange={(event) => setAttributes(event.target.value)}
				/>
				<div className="traces-form-row">
					<select
						className="input"
						aria-label="Time window"
						value={window}
						onChange={(event) => setWindow(Number(event.target.value))}
					>
						{WINDOWS.map((each) => (
							<option key={each.label} value={each.ms}>
								{each.label}
							</option>
						))}
					</select>
					<label className="traces-errors">
						<input type="checkbox" checked={errors} onChange={(event) => setErrors(event.target.checked)} />
						Errors only
					</label>
					<button type="submit" className="button" disabled={!traces || loading}>
						Search
					</button>
				</div>
			</form>
			{message && <output className="notice error">{message}</output>}
			<ul className="traces-list">
				{(found?.traces ?? []).map((trace) => (
					<li key={trace.traceId}>
						<button
							type="button"
							className={`traces-row ${trace.traceId === open ? "on" : ""}`}
							onClick={() => onOpen(trace.traceId)}
						>
							<span className="traces-row-name">
								{trace.errors > 0 && <span className="traces-failed">Failed</span>}
								{trace.name}
							</span>
							<span className="traces-row-meta">
								{clock(trace.startedMs)} · {duration(trace.durationMs)} · {trace.spans} span
								{trace.spans === 1 ? "" : "s"} · {trace.hosts.map(hostLabel).join(", ")}
							</span>
						</button>
					</li>
				))}
			</ul>
			{found && found.traces.length === 0 && <p className="empty-note">No traces</p>}
			{!found && !message && <p className="empty-note">{traces ? "Searching…" : "Loading…"}</p>}
			{found?.cursor !== undefined && (
				<button
					type="button"
					className="text-action traces-more"
					disabled={loading}
					onClick={() => found.cursor && void search({ ...found.query, cursor: found.cursor }, found.traces)}
				>
					Load more
				</button>
			)}
		</section>
	);
}

/** One trace: its spans as a tree on its timeline; a span opens to its attributes, events and links. */
function TraceDetail({
	traceId,
	onOpen,
	onBack,
}: {
	traceId: string;
	onOpen: (traceId: string) => void;
	onBack: () => void;
}) {
	const traces = useObject(Traces, {}, { variant: "owner" });
	const [trace, setTrace] = useState<{ id: string; value?: Trace | null; error?: string }>();
	useEffect(() => {
		if (!traces) return;
		let current = true;
		traces.getTrace({ traceId }, BACKGROUND_CONTEXT).then(
			(value) => current && setTrace({ id: traceId, value }),
			(error: unknown) => current && setTrace({ id: traceId, error: errorText(error) }),
		);
		return () => {
			current = false;
		};
	}, [traces, traceId]);
	const shown = trace?.id === traceId ? trace : undefined;
	return (
		<section className="traces-detail" aria-label="Trace">
			<div className="traces-detail-head">
				<button type="button" className="text-action traces-back" onClick={onBack}>
					All traces
				</button>
				<code className="traces-id">{traceId}</code>
			</div>
			{shown?.error ? (
				<output className="notice error">{shown.error}</output>
			) : shown?.value === null ? (
				<p className="empty-note">No such trace (never recorded, or older than 7 days)</p>
			) : shown?.value ? (
				<SpanTree trace={shown.value} onOpen={onOpen} />
			) : (
				<div className="spinner" />
			)}
		</section>
	);
}

/** A span in the tree: its depth below the trace's roots. */
type Row = { readonly span: Span; readonly depth: number };

/** The spans of `trace` depth first, children by start; a span whose parent is not in the trace is a root. */
function treeRows(trace: Trace): Row[] {
	const ids = new Set(trace.spans.map((span) => span.id));
	const children = new Map<string, Span[]>();
	const roots: Span[] = [];
	for (const span of trace.spans) {
		if (span.parentId === undefined || !ids.has(span.parentId)) roots.push(span);
		else children.set(span.parentId, [...(children.get(span.parentId) ?? []), span]);
	}
	const rows: Row[] = [];
	const visit = (span: Span, depth: number) => {
		rows.push({ span, depth });
		for (const child of children.get(span.id) ?? []) visit(child, depth + 1);
	};
	for (const root of roots) visit(root, 0);
	return rows;
}

/** The trace's spans as rows with their place on the trace's timeline. */
function SpanTree({ trace, onOpen }: { trace: Trace; onOpen: (traceId: string) => void }) {
	const rows = useMemo(() => treeRows(trace), [trace]);
	const [open, setOpen] = useState<string>();
	const start = Math.min(...trace.spans.map((span) => span.startedMs));
	const end = Math.max(...trace.spans.map((span) => span.endedMs));
	const total = Math.max(end - start, 0.001);
	return (
		<>
			<p className="traces-summary">
				{clock(start)} · {duration(end - start)} · {trace.spans.length} spans
				{trace.truncated ? " (only the first 2000)" : ""}
			</p>
			<ul className="traces-tree">
				{rows.map(({ span, depth }) => {
					const failed = span.status.status === "error";
					const at = span.attributes["chord.host"];
					return (
						<li key={span.id} className={failed ? "failed" : ""}>
							<button
								type="button"
								className={`traces-span ${open === span.id ? "on" : ""}`}
								aria-expanded={open === span.id}
								onClick={() => setOpen(open === span.id ? undefined : span.id)}
							>
								<span
									className="traces-span-name"
									style={{ paddingInlineStart: `${Math.min(depth, 12) * 12}px` }}
								>
									{failed && <span className="traces-failed">Failed</span>}
									{span.name} {spanLabel(span)}
								</span>
								<span className="traces-span-meta">
									{typeof at === "string" ? hostLabel(at) : ""} · {duration(span.endedMs - span.startedMs)}
								</span>
								<span className="traces-bar" aria-hidden="true">
									<span
										style={{
											insetInlineStart: `${((span.startedMs - start) / total) * 100}%`,
											width: `max(2px, ${((span.endedMs - span.startedMs) / total) * 100}%)`,
										}}
									/>
								</span>
							</button>
							{open === span.id && <SpanDetail span={span} start={start} onOpen={onOpen} />}
						</li>
					);
				})}
			</ul>
		</>
	);
}

/** A span's attributes, failure, events (by their offset in the trace) and links. */
function SpanDetail({ span, start, onOpen }: { span: Span; start: number; onOpen: (traceId: string) => void }) {
	return (
		<div className="traces-span-detail">
			<p className="traces-muted">
				+{duration(span.startedMs - start)} · {duration(span.endedMs - span.startedMs)} · {span.id}
			</p>
			{span.status.status === "error" && span.status.error && (
				<output className="notice error">
					{span.status.error.name}: {span.status.error.message}
				</output>
			)}
			<Attributes attributes={span.attributes} />
			{span.events.length > 0 && (
				<>
					<h4>Events</h4>
					<ul className="traces-events">
						{span.events.map((event, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a span's events never change.
							<li key={index}>
								<span>
									+{duration(span.startedMs - start + event.timeMs)} {event.name}
								</span>
								<Attributes attributes={event.attributes} />
							</li>
						))}
					</ul>
				</>
			)}
			{span.links.length > 0 && (
				<>
					<h4>Links</h4>
					<ul className="traces-events">
						{span.links.map((link) => (
							<li key={`${link.traceId}:${link.spanId}`}>
								<button type="button" className="text-action" onClick={() => onOpen(link.traceId)}>
									Trace {link.traceId}
								</button>
								<span className="traces-muted"> span {link.spanId}</span>
								{link.attributes && <Attributes attributes={link.attributes} />}
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
}

/** Attributes as a key/value list. */
function Attributes({ attributes }: { attributes: Span["attributes"] }) {
	const entries = Object.entries(attributes);
	if (!entries.length) return null;
	return (
		<dl className="traces-attributes">
			{entries.map(([key, value]) => (
				<div key={key}>
					<dt>{key}</dt>
					<dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
				</div>
			))}
		</dl>
	);
}

/** What a Chord span acts on, after its name: the contract and member, or the object. */
function spanLabel(span: Span): string {
	const { type, member, object } = span.attributes;
	if (typeof type === "string") return typeof member === "string" ? `${type}.${member}` : type;
	return typeof object === "string" ? object : "";
}

/** A host as the lists name it: the browser, the server, a session's worker (`session|<id>`, shortened). */
function hostLabel(host: string): string {
	return host.startsWith("session|") ? `session ${host.slice(8, 16)}` : host;
}

/** A wall-clock time of day, to the millisecond. */
function clock(ms: number): string {
	const date = new Date(ms);
	return `${date.toLocaleTimeString([], { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/** A length of time: microseconds below 1 ms, milliseconds below 10 s, else seconds. */
function duration(ms: number): string {
	if (ms < 1) return `${Math.round(ms * 1000)} µs`;
	if (ms < 10_000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
	return `${(ms / 1000).toFixed(1)} s`;
}

/** `key=value, …` as equalities (a number or `true`/`false` typed as such), or why it is not. */
function parseAttributes(text: string): Record<string, string | number | boolean> | string {
	const out: Record<string, string | number | boolean> = {};
	for (const part of text.split(",").map((each) => each.trim())) {
		if (!part) continue;
		const at = part.indexOf("=");
		if (at < 1) return `"${part}": write attributes as key=value`;
		const value = part.slice(at + 1).trim();
		out[part.slice(0, at).trim()] =
			value === "true" ? true : value === "false" ? false : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
	}
	if (Object.keys(out).length > MAX_FILTERS) return `At most ${MAX_FILTERS} attributes`;
	return out;
}
