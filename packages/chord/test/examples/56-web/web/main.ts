// The board app's web entry (the base bundle the server builds at start): `startPage` with the app's web modules and
// React, a core facet serving `Panels`, and a React page showing the panels (`useRegistry`).

import * as React from "react";
import { createElement as h } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as chord from "../../../../src/index.ts";
import { HostProvider, useRegistry } from "../../../../src/react/index.ts";
import { startPage } from "../../../../src/web/index.ts";
import * as v1web from "../app/v1/web.ts";
import * as v1 from "../app/v1.ts";

const core = chord.defineFacet((host) =>
	host.serve(v1web.Panels, { compose: (table) => table.map(({ value }) => value) }),
);

function Board() {
	const panels = useRegistry(v1web.Panels) ?? [];
	return h("main", null, ...panels.map(({ title, text }) => h("section", { key: title }, h("h2", null, title), text)));
}

/** Starts the page (the entry's caller: Chord's package has no side effects for bundlers). */
export function start(): void {
	void startPage({
		connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
		modules: { "@board/app/v1": v1, "@board/app/v1/web": v1web, react: React, "react/jsx-runtime": jsx },
		core: [{ name: "@board/core", facet: core }],
		render: (host) => createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(Board))),
	});
}

start();
