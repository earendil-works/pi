// The reload suite's page (the base bundle's code; `entry.ts` starts it): `startPage` with the suite's API modules and React, and a page that
// renders every contributed view (`Views`) in its own section, a draft input of its own (base code: no plugin reload
// touches it), and a tall spacer so the tests can scroll. The tests reach the page through `globalThis.reload` (the
// probe of the web API) and `globalThis.page` (loads, the connection, dropping the link, holding the reconnect).

import * as React from "react";
import { createElement as h, useState } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as chord from "../../../../src/index.ts";
import { HostProvider } from "../../../../src/react/index.ts";
import { startPage } from "../../../../src/web/index.ts";
import * as webApi from "./web-api.ts";

/** What the tests read and drive besides the probe. */
type PageControl = {
	loads: number;
	connection?: string;
	/** What the page reported (`startPage`'s `onError`): the kind, and the plugins of a `plugins` report. */
	errors: { readonly kind: string; readonly plugins: readonly string[] }[];
	socket?: WebSocket;
	/** While set, the page does not reconnect: the tests resolve it. */
	gate?: Promise<boolean>;
	release?: () => void;
	/** Closes the page's socket (the connection loop reconnects, after `gate` if set). */
	dropLink(): void;
	/** Holds the page's reconnects until `release`. */
	holdReconnect(): void;
};

/** The tests' hand on the page, made when it starts. */
function pageControl(): PageControl {
	const page: PageControl = {
		loads: 0,
		errors: [],
		dropLink() {
			page.socket?.close();
		},
		holdReconnect() {
			const gate = Promise.withResolvers<boolean>();
			page.gate = gate.promise;
			page.release = () => {
				page.gate = undefined;
				gate.resolve(true);
			};
		},
	};
	return page;
}

/** The base bundle's facet: it serves `Views`, composed in name order. */
const core = chord.defineFacet((host) =>
	host.serve(webApi.Views, {
		compose: (table) => table.map(({ value }) => value).sort((a, b) => a.name.localeCompare(b.name)),
	}),
);

function App() {
	const views = webApi.useRegistry(webApi.Views) ?? [];
	const [draft, setDraft] = useState("");
	return h(
		"div",
		null,
		h("input", {
			id: "base-draft",
			value: draft,
			onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
		}),
		h(
			"div",
			{ id: "views" },
			...views.map((view) => h("section", { key: view.name, "data-view": view.name }, h(view.component))),
		),
		h("div", { id: "spacer", style: { height: "5000px" } }),
	);
}

/** Starts the page (Chord's package is free of side effects for bundlers: an entry calls this). */
export function start(): void {
	const page = pageControl();
	page.loads++;
	(globalThis as unknown as { page: PageControl }).page = page;
	(globalThis as unknown as { reload: typeof webApi.probe }).reload = webApi.probe;
	void startPage({
		connect: () => {
			const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`);
			page.socket = socket;
			return socket;
		},
		modules: { "@test/app/v1": chord, "@test/app/v1/web": webApi, react: React, "react/jsx-runtime": jsx },
		core: [{ name: "@test/core", facet: core }],
		canRetry: () => page.gate ?? Promise.resolve(true),
		onError: (error) => {
			page.errors.push({
				kind: error.kind,
				plugins: error.kind === "plugins" ? error.failed.map(({ plugin }) => plugin) : [],
			});
		},
		onConnection: (state) => {
			page.connection = state;
		},
		render: (host) => {
			webApi.probe.host = host;
			createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(App)));
		},
	});
}
