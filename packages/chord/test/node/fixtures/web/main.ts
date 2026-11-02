// The web entry of the browser tests (the base bundle): `startPage` with the tests' API modules and React, a core facet
// serving `Panels` and the counter, and a React app: the panels (`useRegistry`), a draft input (component state an
// in-place reload keeps), and a counter held while shown (`useHold`, `useWatch`, `useRefState`).

import * as React from "react";
import { createElement as h, useState } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import * as chord from "../../../../src/index.ts";
import { HostProvider, useHold, useRefState, useRegistry, useWatch } from "../../../../src/react/index.ts";
import { startPage } from "../../../../src/web/index.ts";
import * as webApi from "./api.ts";

const { defineFacet } = chord;

/** What the tests read from the page. */
const probe = globalThis as unknown as { loads: number; counterState?: () => string | undefined; connection?: string };
probe.loads = (probe.loads ?? 0) + 1;

const core = defineFacet((host) => {
	host.serve(webApi.Panels, { compose: (table) => table.map(({ value }) => value) });
	host.serve(webApi.Counter, (_params, self) => {
		const count = self.writable(0);
		return {
			count: self.derive([count], ([value]) => value),
			increment: async () => {
				count.set(count.value + 1);
				return null;
			},
		};
	});
});

function Counter() {
	const ref = useHold(webApi.Counter, {});
	const count = useWatch(ref?.count);
	const state = useRefState(ref);
	probe.counterState = () => ref?.state.value.kind;
	return h(
		"button",
		{
			type: "button",
			id: "count",
			"data-state": state?.kind,
			onClick: () => void ref?.increment(BACKGROUND_CONTEXT),
		},
		String(count ?? "…"),
	);
}

function App() {
	const panels = useRegistry(webApi.Panels) ?? [];
	const [draft, setDraft] = useState("");
	const [shown, setShown] = useState(true);
	return h(
		"div",
		null,
		h("ul", { id: "panels" }, ...panels.map((panel) => h("li", { key: panel, className: "panel" }, panel))),
		h("input", {
			id: "draft",
			value: draft,
			onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
		}),
		h("button", { type: "button", id: "toggle", onClick: () => setShown((value) => !value) }, "toggle"),
		shown ? h(Counter) : null,
	);
}

/** Starts the page (Chord's package is free of side effects for bundlers: the entry calls this). */
export function start(): void {
	void startPage({
		connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
		modules: { "@test/app/v1": chord, "@test/app/v1/web": webApi, react: React, "react/jsx-runtime": jsx },
		core: [{ name: "@test/core", facet: core }],
		onConnection: (state) => {
			probe.connection = state;
		},
		render: (host) => createRoot(document.getElementById("root")!).render(h(HostProvider, { host }, h(App))),
	});
}
