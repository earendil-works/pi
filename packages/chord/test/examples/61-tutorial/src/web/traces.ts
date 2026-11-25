// The owner's trace viewer, the page at `/traces`: the newest traces of the app's telemetry store (all, or those for
// one principal: `user:u1`, `owner`), each with whom it was for, and the one chosen
// (its id in the URL's fragment) as a tree: each span with its host (`chord.host`), its length as a bar on the trace's
// time line, its attributes and events, its error marked, and its links as references to other traces, never
// followed. It reads the traces plugin's JSON routes (`plugins/traces/server.ts`), which answer the owner only.

import { createElement as h, useEffect, useState } from "react";

/** A trace in the list (`GET /api/traces`). */
type Summary = {
	readonly id: string;
	readonly name: string;
	readonly detail: string;
	readonly principal: string;
	readonly spans: number;
	readonly hosts: number;
	readonly durationMs: number;
	readonly error: boolean;
};

/** A span of the tree (`GET /api/traces/:id`), parents before their children. */
type Row = {
	readonly name: string;
	readonly depth: number;
	readonly host: string;
	readonly offsetMs: number;
	readonly durationMs: number;
	readonly attributes: readonly string[];
	readonly events: readonly string[];
	readonly links: readonly string[];
	readonly error: string | null;
};

/** What a route answered: its JSON, or its status when it refused. */
type Answer<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "refused"; readonly status: number };

/** The viewer: the list, and the chosen trace's tree. */
export function TraceViewer() {
	const [list, setList] = useState<Answer<readonly Summary[]>>();
	const [principal, setPrincipal] = useState("");
	const [chosen, setChosen] = useState(fragment);
	const [trace, setTrace] = useState<Answer<{ readonly spans: readonly Row[] }>>();
	useEffect(() => {
		const follow = () => setChosen(fragment());
		addEventListener("hashchange", follow);
		return () => removeEventListener("hashchange", follow);
	}, []);
	useEffect(() => {
		const query = principal === "" ? "" : `?principal=${encodeURIComponent(principal)}`;
		void read<readonly Summary[]>(`/api/traces${query}`).then(setList);
	}, [principal]);
	useEffect(() => {
		setTrace(undefined);
		if (chosen === "") return;
		void read<{ readonly spans: readonly Row[] }>(`/api/traces/${encodeURIComponent(chosen)}`).then(setTrace);
	}, [chosen]);
	if (list?.kind === "refused") return h("p", null, `The traces are the owner's (${list.status}).`);
	return h(
		"div",
		{ className: "traces" },
		h(
			"nav",
			null,
			h("h2", null, "Traces"),
			h("input", {
				className: "traces-filter",
				placeholder: "principal",
				value: principal,
				onChange: (event: { target: { value: string } }) => setPrincipal(event.target.value),
			}),
			...(list?.value ?? []).map((summary) =>
				h(
					"a",
					{
						key: summary.id,
						href: `#${encodeURIComponent(summary.id)}`,
						className: summary.id === chosen ? "traces-chosen" : undefined,
					},
					h("span", { className: summary.error ? "traces-error" : undefined }, summary.name),
					h("small", null, [summary.detail, summary.principal].filter((part) => part !== "").join(" · ")),
					h(
						"small",
						null,
						`${count(summary.spans, "span")} · ${count(summary.hosts, "host")} · ${ms(summary.durationMs)}`,
					),
				),
			),
		),
		trace?.kind === "ok" ? h(Tree, { rows: trace.value.spans }) : null,
	);
}

/** One trace as a tree: a colour per host (the host that recorded the span), lengths on the trace's time line. */
function Tree({ rows }: { readonly rows: readonly Row[] }) {
	const total = Math.max(...rows.map((row) => row.offsetMs + row.durationMs));
	const hosts = [...new Set(rows.map((row) => row.host))];
	return h(
		"ol",
		{ className: "traces-tree" },
		...rows.map((row, index) => h(Span, { key: index, row, colour: hosts.indexOf(row.host), total })),
	);
}

/** One span: its host, name and length, its bar, then its attributes, events, links and error. */
function Span({ row, colour, total }: { readonly row: Row; readonly colour: number; readonly total: number }) {
	const indent = { paddingLeft: `${row.depth * 1.1}rem` };
	// Inline styles are set through the DOM by React, which the page's CSP allows (it refuses style attributes in HTML).
	const bar = {
		left: `${(row.offsetMs / total) * 100}%`,
		width: `${Math.max((row.durationMs / total) * 100, 0.5)}%`,
	};
	return h(
		"li",
		{ className: row.error === null ? undefined : "traces-failed" },
		h(
			"div",
			{ className: "traces-span", style: indent },
			h("span", { className: `traces-host traces-host-${colour % 4}` }, row.host),
			h("b", null, row.name),
			h("span", { className: "traces-ms" }, ms(row.durationMs)),
		),
		h(
			"div",
			{ className: "traces-line" },
			h("span", { className: `traces-bar traces-host-${colour % 4}`, style: bar }),
		),
		h(
			"div",
			{ className: "traces-details", style: indent },
			row.attributes.join("  "),
			...row.events.map((event) => h("div", { key: event }, `· ${event}`)),
			...row.links.map((link) => h("div", { key: link, className: "traces-link" }, `→ link to ${link}`)),
			row.error === null ? null : h("div", { className: "traces-error" }, `error: ${row.error}`),
		),
	);
}

/** Reads one of the viewer's routes. */
async function read<T>(path: string): Promise<Answer<T>> {
	const response = await fetch(path, { credentials: "same-origin" });
	if (!response.ok) return { kind: "refused", status: response.status };
	// The traces plugin's JSON from the page's own server: the shape its routes write.
	return { kind: "ok", value: (await response.json()) as T };
}

/** The chosen trace's id: the URL's fragment. */
function fragment(): string {
	return decodeURIComponent(location.hash.slice(1));
}

/** `n` things: `1 span`, `6 spans`. */
function count(n: number, thing: string): string {
	return `${n} ${thing}${n === 1 ? "" : "s"}`;
}

/** A length in milliseconds, as the viewer shows it. */
function ms(value: number): string {
	return value < 10 ? `${value.toFixed(2)} ms` : `${Math.round(value)} ms`;
}
