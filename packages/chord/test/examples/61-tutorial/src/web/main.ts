// The todo app's web entry, the base bundle the server builds at start: `startPage` with the app's web modules and
// React, a core facet serving the `Panels` registry, and a page showing every panel the plugins contribute.

import * as React from "react";
import { createElement as h } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { defineFacet } from "../../../../../src/index.ts";
import { HostProvider, useRegistry } from "../../../../../src/react/index.ts";
import { startPage } from "../../../../../src/web/index.ts";
import * as v1 from "../api/v1/index.ts";
import * as v1web from "../api/v1/web.ts";
import "./style.css";

/** The page's own facet: it serves `Panels`, composing the contributions in plugin-name order. */
const core = defineFacet((host) => host.serve(v1web.Panels, { compose: (table) => table.map(({ value }) => value) }));

function Page() {
	const panels = useRegistry(v1web.Panels) ?? [];
	return h(
		"main",
		null,
		h("h1", null, "Todo"),
		...panels.map(({ title, Component }) => h("section", { key: title }, h("h2", null, title), h(Component))),
	);
}

void startPage({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@todo/app/v1": v1, "@todo/app/v1/web": v1web, react: React, "react/jsx-runtime": jsx },
	core: [{ name: "@todo/web", facet: core }],
	render: (host) => createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(Page))),
});
